import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { AuditLog } from '../src/auditLog.js';
import { dispatchCli } from '../src/cli.js';
import {
  parsePullRequest,
  PullRequestMonitor,
  resolvePullRequestBinding,
} from '../src/prMonitor.js';
import { canonicalPullRequest, pullRequestRepository } from '../src/pullRequestBinding.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import type { WorkStore } from '../src/workstore/WorkStore.js';
import { operatorToken } from './helpers/operatorToken.js';

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: () => process.env.HOME ?? actual.homedir() };
});
const fixture = () => fs.readFileSync(path.join(__dirname, 'fixtures/gh/open-green.json'), 'utf8');
// Exercise the actual resolver and CLI. Only the external gh transport is replaced.
vi.mock('../src/prMonitor.js', async (original) => {
  const actual = await original<typeof import('../src/prMonitor.js')>();
  return {
    ...actual,
    resolvePullRequestBinding: vi.fn((cwd: string, repository: string, selector: string) =>
      actual.resolvePullRequestBinding(cwd, repository, selector, async () => fixture()),
    ),
  };
});

let root: string;
let work: WorkStore;
const repository = 'https://github.com/example/project';
const ref = `${repository}/pull/42`;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-binding-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'no-config'));
  for (const key of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(key, undefined);
  execFileSync('git', ['init', root], { windowsHide: true, stdio: 'pipe' });
  fs.mkdirSync(path.join(root, '.softwareagents/brain'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.softwareagents/project.yaml'),
    `apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: p\nname: Test\nrepo:\n  remote: ${repository}.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n`,
  );
  operatorToken(root);
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  work = await openWorkStore({ repositoryPath: root, projectId: 'p' });
  work.createTask({ key: 'task', type: 'implementation', status: 'REVIEW' });
});
afterEach(() => {
  work?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it.each(['42', ref, 'reused-branch'])(
  'binds %s through dispatchCli and polls its pinned identity',
  async (selector) => {
    await dispatchCli(['task', 'bind-pr', 'task', selector]);
    expect(work.getTask('task')).toMatchObject({
      status: 'REVIEW',
      lease_owner: null,
      pr_ref: ref,
      pr_status: null,
    });
    const read = vi.fn(async () => fixture());
    const poller = new PullRequestMonitor({ repositoryPath: root, projectId: 'p', read });
    await poller.tick();
    expect(read.mock.calls[0]).toEqual([root, ref, expect.any(AbortSignal)]);
    expect(work.getTask('task')!.pr_status).toMatchObject({ ci: 'success', ref });
    expect(work.listDecisions()).toEqual([]);
    expect(resolvePullRequestBinding).toHaveBeenCalledWith(root, repository, selector);
    await poller.dispose();
  },
);

it('rejects a reused branch returning a different PR during monitoring', async () => {
  await dispatchCli(['task', 'bind-pr', 'task', 'reused-branch']);
  const poller = new PullRequestMonitor({
    repositoryPath: root,
    projectId: 'p',
    log: vi.fn(),
    read: async () => JSON.stringify({ ...JSON.parse(fixture()), url: `${repository}/pull/43` }),
  });
  await poller.tick();
  expect(work.getTask('task')).toMatchObject({
    pr_ref: ref,
    pr_status: null,
    pr_observation: { error: 'unavailable' },
  });
  await poller.dispose();
});

it('requires operator ingress for binding and leaves the task untouched', async () => {
  vi.stubEnv('SA_MANAGED_EXECUTION', 'yes');
  await expect(dispatchCli(['task', 'bind-pr', 'task', '42'])).rejects.toThrow('human operator');
  expect(work.getTask('task')!.pr_ref).toBeNull();
});

it('retries a monitor CI block through CLI human ingress with intent and committed audit', async () => {
  await dispatchCli(['task', 'bind-pr', 'task', '42']);
  const poller = new PullRequestMonitor({
    repositoryPath: root,
    projectId: 'p',
    read: async () => fs.readFileSync(path.join(__dirname, 'fixtures/gh/failed.json'), 'utf8'),
  });
  await poller.tick();
  expect(work.getTask('task')).toMatchObject({ status: 'BLOCKED', ci_restore_status: 'REVIEW' });
  const blocked = work.getTask('task')!;
  vi.stubEnv('SA_MANAGED_EXECUTION', 'yes');
  await expect(dispatchCli(['task', 'retry', 'task', '--reason', 'CI fixed'])).rejects.toThrow(
    'human operator',
  );
  expect(work.getTask('task')).toEqual(blocked);
  vi.stubEnv('SA_MANAGED_EXECUTION', undefined);
  await dispatchCli(['task', 'retry', 'task', '--reason', 'CI fixed']);
  expect(work.getTask('task')).toMatchObject({
    status: 'REVIEW',
    version: blocked.version + 1,
    ci_restore_status: null,
    blocked_reason: null,
  });
  expect(
    new AuditLog()
      .read('p')
      .flatMap((row) => (row.corrupt ? [] : [row.entry]))
      .filter((entry) => entry.action === 'manual_retry')
      .map((entry) => entry.outcome.status),
  ).toEqual(['intent', 'committed']);
  await poller.dispose();
});

it('fences stale bindings and refuses another repository at the store entry point', async () => {
  const before = work.getTask('task')!;
  await work.bindPullRequest('task', before.version, ref);
  await work.bindPullRequest('task', before.version, ref);
  expect(work.getTask('task')!.version).toBe(before.version);
  await work.transition('task', before.version, 'BLOCKED', 'human hold', 'operator');
  await expect(work.bindPullRequest('task', before.version, ref)).rejects.toThrow('changed');
  await expect(
    work.bindPullRequest(
      'task',
      work.getTask('task')!.version,
      'https://github.com/other/project/pull/42',
    ),
  ).rejects.toThrow('repository');
  expect(canonicalPullRequest('https://GITHUB.com/Example/Project/pull/42')).toBe(ref);
  expect(pullRequestRepository('git@github.com:Example/Project.git')).toBe(repository);
});

it.each([`${ref}?tab=checks`, `${repository}/pull/042`])(
  'replaces legacy selector %s through authenticated CLI binding',
  async (legacy) => {
    work.createTask({ key: 'legacy', type: 'implementation', status: 'REVIEW', pr_ref: legacy });
    const before = work.getTask('legacy')!;
    await dispatchCli(['task', 'bind-pr', 'legacy', '42']);
    expect(work.getTask('legacy')).toMatchObject({
      version: before.version,
      status: before.status,
      pr_ref: ref,
      pr_status: null,
      pr_observation: null,
    });
  },
);

it('discards an observation of the old PR after rebinding at the same lifecycle version', async () => {
  const version = work.getTask('task')!.version;
  await work.bindPullRequest('task', version, ref);
  const observation = parsePullRequest(fixture(), ref);
  const poll = (await work.beginPullRequestPoll(
    'task',
    ref,
    work.getTask('task')!.pr_binding_generation!,
  ))!;
  const rebound = `${repository}/pull/43`;
  await work.bindPullRequest('task', version, rebound);
  await expect(
    work.observePullRequest('task', version, ref, observation, undefined, poll),
  ).rejects.toThrow('PR reference changed');
  expect(work.getTask('task')).toMatchObject({
    version,
    pr_ref: rebound,
    pr_status: null,
    pr_observation: null,
  });
});

it('rejects other repositories and unsafe URL inputs before invoking gh', async () => {
  const actual = await vi.importActual<typeof import('../src/prMonitor.js')>('../src/prMonitor.js');
  const read = vi.fn(async () => fixture());
  for (const selector of [
    'https://github.com/other/project/pull/42',
    'https://github.com:443/example/project/pull/42',
    'https://user@github.com/example/project/pull/42',
  ]) {
    await expect(
      actual.resolvePullRequestBinding(root, repository, selector, read),
    ).rejects.toThrow();
  }
  expect(read).not.toHaveBeenCalled();
  await expect(
    actual.resolvePullRequestBinding(root, 'https://github.com/other/project', 'branch', read),
  ).rejects.toThrow('repository');
});
