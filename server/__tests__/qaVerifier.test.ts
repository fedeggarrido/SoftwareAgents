import { DatabaseSync } from 'node:sqlite';

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QA_MAX_TEST_FILES } from '../src/constants.js';
import { lastDeveloperFailure } from '../src/developer.js';
import { runIsolatedVitest } from '../src/evalCriteria.js';
import { loadModelPolicy } from '../src/modelPolicy.js';
import { qaCommands, qaRequestedCommands, qaTestFiles } from '../src/qa.js';
import { lastReviewFailure, reviewReworkRounds } from '../src/reviewAttempts.js';
import type { ReviewerRequest } from '../src/reviewer.js';
import { VERIFIER_INFRASTRUCTURE_PREFIX } from '../src/verifierInfrastructure.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import type { DomainEventRecord, TaskRecord, WorkStore } from '../src/workstore/WorkStore.js';

vi.setConfig({ testTimeout: 90_000 });
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));
let root: string;
let tree: string;
let scratch: string;
let link: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: tree, windowsHide: true, encoding: 'utf8' });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-verifier-'));
  tree = path.join(root, 'tree');
  scratch = path.join(root, 'scratch');
  fs.mkdirSync(path.join(tree, 'server/__tests__'), { recursive: true });
  fs.mkdirSync(scratch);
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) vi.stubEnv(key, root);
  vi.stubEnv('QA_SECRET_SENTINEL', 'must-not-leak');
  link = path.join(tree, 'node_modules');
  fs.symlinkSync(
    path.dirname(path.dirname(require.resolve('vitest/package.json'))),
    link,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
});
afterEach(() => {
  // Only unlink the fixture junction. Retain test evidence under the isolated TEMP.
  if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(link);
  vi.unstubAllEnvs();
});
const source = (text: string, file = 'server/__tests__/check.test.ts') =>
  fs.writeFileSync(path.join(tree, file), text);
const verify = () => runIsolatedVitest(tree, scratch, 'server/__tests__/check.test.ts');

describe('Shared isolated QA verifier', () => {
  it('builds server hooks in a scratch snapshot and leaves the approved task tree clean', async () => {
    fs.unlinkSync(link);
    git('init', '-b', 'main', '--separate-git-dir', path.join(root, 'metadata'));
    fs.writeFileSync(
      path.join(tree, 'esbuild.js'),
      `
const fs = require('fs');
const esbuild = require('esbuild');
if (fs.existsSync('.git')) throw new Error('snapshot contains Git metadata');
esbuild.buildSync({ stdin: { contents: 'module.exports = "built hook";' }, outfile: 'dist/hooks/claude-hook.js', platform: 'node' });
esbuild.buildSync({ stdin: { contents: 'module.exports = "built containment";' }, outfile: 'dist/hooks/containment-hook.js', platform: 'node' });
`,
    );
    source(`import { it, expect } from 'vitest';
it('requires built hooks', () => {
  expect(require('../../dist/hooks/claude-hook.js')).toBe('built hook');
  expect(require('../../dist/hooks/containment-hook.js')).toBe('built containment');
});`);
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
    const sha = git('rev-parse', 'HEAD').trim();
    const input = {
      worktree: tree,
      reviewRef: { sha },
      files: ['server/__tests__/check.test.ts'],
      task: { changeZones: [], testZones: [] },
    } as unknown as ReviewerRequest;
    expect(await qaCommands(input, scratch, new AbortController().signal)).toEqual([
      { command: 'vitest:server/__tests__/check.test.ts', result: 'pass', passed: 1, failed: 0 },
    ]);
    expect(git('rev-parse', 'HEAD').trim()).toBe(sha);
    expect(git('status', '--porcelain', '--ignored').trim()).toBe('');
    expect(fs.existsSync(path.join(tree, 'dist'))).toBe(false);
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  it('does not charge Developer attempts for repeated verifier infrastructure failures', async () => {
    git('init', '-b', 'main');
    const store = await openWorkStore({ repositoryPath: tree, projectId: 'test' });
    const key = 'FEAT-001-T01';
    store.createTask({
      key,
      type: 'code',
      agent_role: 'developer',
      status: 'READY',
      max_attempts: 1,
    });
    try {
      for (let i = 0; i < 4; i++) {
        const claimed = await store.claim(key, 'fixture-worker');
        const running = await store.transition(
          key,
          claimed.version,
          'RUNNING',
          'Fixture launch',
          'fixture-worker',
        );
        await store.transition(
          key,
          running.version,
          'FAILED_RETRYABLE',
          VERIFIER_INFRASTRUCTURE_PREFIX + 'build timed out',
          'fixture-worker',
        );
        expect(store.getTask(key)).toMatchObject({ status: 'FAILED_RETRYABLE', attempt: 0 });
      }
    } finally {
      store.close();
    }
  });

  it('retains an unconfirmed verifier lease and recovers it without charging an attempt', async () => {
    git('init', '-b', 'main');
    const store = await openWorkStore({ repositoryPath: tree, projectId: 'test' });
    const db = new DatabaseSync(path.join(tree, '.git/softwareagents/work.sqlite3'));
    const key = 'FEAT-001-T01';
    store.createTask({
      key,
      type: 'code',
      agent_role: 'developer',
      status: 'READY',
      max_attempts: 1,
    });
    try {
      const claimed = await store.claim(key, 'fixture-worker');
      await store.transition(key, claimed.version, 'RUNNING', 'Fixture launch', 'fixture-worker');
      await expect(store.markVerifierInfrastructureFailure(key, 'other-worker')).rejects.toThrow();
      await store.markVerifierInfrastructureFailure(key, 'fixture-worker');
      expect(store.getTask(key)).toMatchObject({
        status: 'RUNNING',
        lease_owner: 'fixture-worker',
        attempt: 0,
      });
      db.prepare('UPDATE tasks SET lease_expires_at = ? WHERE key = ?').run(
        new Date(0).toISOString(),
        key,
      );
      await store.recoverExpiredLeases();
      expect(store.getTask(key)).toMatchObject({
        status: 'FAILED_RETRYABLE',
        attempt: 0,
        lease_owner: null,
        blocked_reason: expect.stringContaining(VERIFIER_INFRASTRUCTURE_PREFIX),
      });
      await store.claim(key, 'resumed-worker');
      expect(store.getTask(key)).toMatchObject({ status: 'LEASED', attempt: 0 });
    } finally {
      db.close();
      store.close();
    }
  });
  it.each(['qa', 'review'] as const)(
    'preserves an unconfirmed %s verifier diagnosis through lease recovery',
    async (phase) => {
      git('init', '-b', 'main');
      const store = await openWorkStore({ repositoryPath: tree, projectId: 'test' });
      const db = new DatabaseSync(path.join(tree, '.git/softwareagents/work.sqlite3'));
      const key = 'FEAT-001-T01';
      store.createTask({ key, type: 'code', status: phase === 'qa' ? 'QA' : 'REVIEW' });
      try {
        db.prepare('UPDATE tasks SET review_ref = ? WHERE key = ?').run(
          JSON.stringify({
            branch: `sa/${key}-developer`,
            sha: 'a'.repeat(40),
            base: 'b'.repeat(40),
          }),
          key,
        );
        await store.claimReview(key, store.getTask(key)!.version, 'fixture-worker', phase);
        await store.markVerifierInfrastructureFailure(key, 'fixture-worker');
        db.prepare('UPDATE tasks SET lease_expires_at = ? WHERE key = ?').run(
          new Date(0).toISOString(),
          key,
        );
        await store.recoverExpiredLeases();
        const task = store.getTask(key)!;
        expect(task).toMatchObject({
          status: phase === 'qa' ? 'QA' : 'REVIEW',
          attempt: 0,
          lease_owner: null,
        });
        expect(lastReviewFailure(store, task)?.reason).toContain(VERIFIER_INFRASTRUCTURE_PREFIX);
      } finally {
        db.close();
        store.close();
      }
    },
  );

  it('selects only T03 diff tests and webview source mirrors unless a test directory is explicit', () => {
    git('init', '-b', 'main', '--separate-git-dir', path.join(root, 'metadata'));
    const files = [
      'webview-ui/src/office/auditStore.ts',
      'webview-ui/test/auditStore.test.ts',
      'webview-ui/test/auditStoreEdges.test.ts',
      'webview-ui/test/changed.test.ts',
      'webview-ui/test/declared.test.ts',
      'webview-ui/test/unrelated.test.ts',
      'webview-ui/test/otherAuditStore.test.ts',
    ];
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(tree, file)), { recursive: true });
      source('// fixture', file);
    }
    git('add', 'webview-ui');
    const input = {
      worktree: tree,
      files: [
        'webview-ui/src/office/auditStore.ts',
        'webview-ui/test/auditStore.test.ts',
        'webview-ui/test/changed.test.ts',
      ],
      task: { changeZones: ['webview-ui/src/office/auditStore.ts'], testZones: [] },
    } as unknown as ReviewerRequest;
    const mirrors = [
      'webview-ui/test/auditStore.test.ts',
      'webview-ui/test/auditStoreEdges.test.ts',
    ];
    expect(qaTestFiles(input)).toEqual([...mirrors, 'webview-ui/test/changed.test.ts']);
    input.files = [];
    expect(qaTestFiles(input)).toEqual(mirrors);
    input.task.changeZones = ['webview-ui/src/office/'];
    expect(qaTestFiles(input)).toEqual(mirrors);
    input.task.changeZones = ['webview-ui/src/**/audit*.ts'];
    expect(qaTestFiles(input)).toEqual(mirrors);
    input.task.testZones = ['webview-ui/test/declared.test.ts'];
    expect(qaTestFiles(input)).toEqual([...mirrors, 'webview-ui/test/declared.test.ts']);
    input.task.testZones = ['webview-ui/test/'];
    expect(qaTestFiles(input)).toEqual(files.filter((file) => file.includes('/test/')).sort());
  });

  it.each(['node:assert', 'node:assert/strict', 'assert', 'assert/strict'])(
    'counts only executed assertions from %s, including default, named and callable exports',
    async (module) => {
      source(`import assert, { equal } from '${module}'; import { it, expect } from 'vitest';
it('equal only', () => assert.equal(1, 1));
it('named equal', () => equal(1, 1));
it('callable', () => assert(true));
it('strict alias', () => assert.strict.equal(1, 1));
it('async assertion', async () => { await assert.rejects(async () => { throw new Error('expected'); }); });
it('failed assertion', () => assert.equal(1, 2));
it('empty assert', () => {});
it('dead assert', () => { if (false) assert.equal(1, 1); });
it('dead expect', () => { if (false) expect(1).toBe(1); });
it('utility is not an assertion', () => { new assert.AssertionError({ message: 'unused' }); });`);
      expect(await verify()).toEqual({ result: 'fail', passed: 5, failed: 5 });
      expect(fs.readdirSync(scratch)).toEqual([]);
    },
  );

  it('runs every real webview test in the isolated runner without changing the checkout', async () => {
    fs.unlinkSync(link);
    const repository = path.resolve(__dirname, '../..');
    const files = execFileSync('git', ['ls-files', '-z', 'webview-ui', 'core'], {
      cwd: repository,
      encoding: 'utf8',
      windowsHide: true,
    })
      .split('\0')
      .filter(Boolean);
    for (const file of files) {
      const target = path.join(tree, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(repository, file), target);
    }
    git('init', '-b', 'main', '--separate-git-dir', path.join(root, 'metadata'));
    git('add', 'webview-ui', 'core');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
    const tests = files.filter((file) => /^webview-ui\/test\/.*\.test\.ts$/.test(file)).sort();
    expect(tests.length).toBeGreaterThanOrEqual(18);
    const commands = await qaCommands(
      {
        worktree: tree,
        reviewRef: { sha: git('rev-parse', 'HEAD').trim() },
        files: [],
        task: { changeZones: [], testZones: ['webview-ui/test/'] },
      } as unknown as ReviewerRequest,
      scratch,
      new AbortController().signal,
    );
    expect(commands.map((row) => row.command)).toEqual(tests.map((file) => 'vitest:' + file));
    expect(commands).toEqual(commands.map((row) => ({ ...row, result: 'pass', failed: 0 })));
    expect(commands.every((row) => row.passed > 0)).toBe(true);
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readdirSync(scratch)).toEqual([]);
    expect(git('status', '--porcelain', '--ignored').trim()).toBe('');
  });

  it.each([true, false])(
    'executes QA webview tests with the Node workspace profile: %s',
    async (pass) => {
      fs.unlinkSync(link);
      git('init', '-b', 'main', '--separate-git-dir', path.join(root, 'metadata'));
      const file = 'webview-ui/test/auditStore.test.ts';
      fs.mkdirSync(path.dirname(path.join(tree, file)), { recursive: true });
      source(
        `import { it, expect } from 'vitest'; import os from 'os';
it('webview runtime', () => {
  expect(process.cwd()).toBe(${JSON.stringify(path.join(tree, 'webview-ui'))});
  expect(typeof window).toBe('undefined');
  expect(typeof globalThis.it).toBe('undefined');
  expect(os.homedir()).toBe(process.env.HOME);
  expect(process.env.QA_SECRET_SENTINEL).toBeUndefined();
  expect(true).toBe(${pass});
});`,
        file,
      );
      // Repository configuration/reporters must never execute in the verifier.
      fs.writeFileSync(
        path.join(tree, 'webview-ui/vitest.config.ts'),
        "throw new Error('untrusted config');",
      );
      git('add', 'webview-ui');
      git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-m',
        'fixture',
      );
      const input = {
        worktree: tree,
        reviewRef: { sha: git('rev-parse', 'HEAD').trim() },
        files: [],
        task: { changeZones: [], testZones: [file] },
      } as unknown as ReviewerRequest;
      expect(qaTestFiles(input)).toEqual([file]);
      expect(await qaCommands(input, scratch, new AbortController().signal)).toEqual([
        {
          command: 'vitest:' + file,
          result: pass ? 'pass' : 'fail',
          passed: pass ? 1 : 0,
          failed: pass ? 0 : 1,
        },
      ]);
      expect(fs.existsSync(link)).toBe(false);
      expect(fs.readdirSync(scratch)).toEqual([]);
      expect(git('status', '--porcelain', '--ignored').trim()).toBe('');
    },
  );

  it('rejects unsupported test roots before creating verifier scratch', async () => {
    await expect(runIsolatedVitest(tree, scratch, 'integration/check.test.ts')).rejects.toThrow(
      /Unsupported Vitest test root/,
    );
    expect(fs.readdirSync(scratch)).toEqual([]);
    git('init', '-b', 'main', '--separate-git-dir', path.join(root, 'metadata'));
    const file = 'integration/check.test.ts';
    fs.mkdirSync(path.join(tree, 'integration'));
    source("it('outside', () => expect(true).toBe(true));", file);
    git('add', 'integration');
    expect(() =>
      qaTestFiles({ worktree: tree, files: [file], task: {} } as unknown as ReviewerRequest),
    ).toThrow(/Unsupported QA test root/);
  });

  it.each(['Runtime commit abc', 'Reviewer report persisted', 'QA report persisted'])(
    'clears visible failures after %s while retaining history and showing newer failures',
    (reason) => {
      const task = { key: 'FEAT-001-T01', type: 'code', agent_role: 'developer' } as TaskRecord;
      const events = [
        {
          to_status: 'FAILED_RETRYABLE',
          reason: 'Worker failed (category=executor)',
          created_at: 'first',
        },
        {
          to_status: 'REVIEW',
          reason: 'Reviewer failed: category=oauth_refresh_contention',
          created_at: 'second',
        },
      ] as DomainEventRecord[];
      const store = { listDomainEvents: () => events } as unknown as WorkStore;
      expect(lastDeveloperFailure(store, task)?.reason).toBe(events[0].reason);
      expect(lastReviewFailure(store, task)?.reason).toBe(events[1].reason);
      events.push({ to_status: 'RUNNING', reason: 'Claim QA lease' } as DomainEventRecord);
      expect(lastDeveloperFailure(store, task)).not.toBeNull();
      expect(lastReviewFailure(store, task)).not.toBeNull();
      events.push({ to_status: 'REVIEW', reason } as DomainEventRecord);
      expect(lastDeveloperFailure(store, task)).toBeNull();
      expect(lastReviewFailure(store, task)).toBeNull();
      expect(events.slice(0, 2).map((event) => event.created_at)).toEqual(['first', 'second']);
      events.push({
        to_status: 'FAILED_RETRYABLE',
        reason: 'Worker failed again',
        created_at: 'new',
      } as DomainEventRecord);
      expect(lastDeveloperFailure(store, task)).toEqual({
        reason: 'Worker failed again',
        created_at: 'new',
      });
      events.push({
        to_status: 'QA',
        reason: 'QA failed: category=auth',
        created_at: 'newer',
      } as DomainEventRecord);
      expect(lastReviewFailure(store, task)).toEqual({
        reason: 'QA failed: category=auth',
        created_at: 'newer',
      });
      expect(lastDeveloperFailure(store, task)?.reason).toBe('Worker failed again');
    },
  );
  it('counts valid Reviewer and QA rejections, excluding historical infrastructure attempts', () => {
    const task = {
      attempt: 99,
      review_reports: [
        { report: { verdict: 'approve' } },
        { report: { verdict: 'request_changes' } },
      ],
      test_reports: [
        { report: { verdict: 'fail' } },
        { report: { verdict: 'pass' } },
        { report: { verdict: 'not_tested' } },
      ],
    } as TaskRecord;
    expect(reviewReworkRounds(task)).toBe(2);
  });
  it('accepts only one bounded request envelope of runtime command IDs', () => {
    const commands = [
      {
        command: 'vitest:server/__tests__/check.test.ts',
        result: 'pass' as const,
        passed: 1,
        failed: 0,
      },
    ];
    expect(
      qaRequestedCommands(
        JSON.stringify({ requestCommands: [commands[0].command] }),
        commands,
        false,
      ),
    ).toEqual([commands[0].command]);
    for (const value of [
      { requestCommands: ['npm install'] },
      { requestCommands: [] },
      { requestCommands: [commands[0].command, commands[0].command] },
      { requestCommands: [commands[0].command], argv: ['node', 'evil.js'] },
    ])
      expect(() => qaRequestedCommands(JSON.stringify(value), commands, false)).toThrow();
    expect(() =>
      qaRequestedCommands(
        JSON.stringify({ requestCommands: [commands[0].command] }),
        commands,
        true,
      ),
    ).toThrow();
  });
  it('isolates environment and Windows os.homedir, runs only selected files and returns JSON counts', async () => {
    source(
      "import { it, expect } from 'vitest'; import os from 'os'; import fs from 'fs'; import path from 'path'; it('isolates', () => { const runtime = path.dirname(process.env.HOME); expect(fs.existsSync(path.join(runtime, 'vitest.config.mjs'))).toBe(true); expect(fs.existsSync(path.join(runtime, 'isolated-home.mjs'))).toBe(true); fs.writeFileSync(path.join(process.env.HOME, 'runtime-output'), 'isolated'); expect(fs.existsSync(path.join(process.env.HOME, 'runtime-output'))).toBe(true); expect(process.env.QA_SECRET_SENTINEL).toBeUndefined(); expect(os.homedir()).toBe(process.env.HOME); expect(process.env.USERPROFILE).toBe(process.env.HOME); expect(process.env.HOME).not.toBe(" +
        JSON.stringify(root) +
        '); });',
    );
    source(
      "throw new Error('unselected test must not execute')",
      'server/__tests__/unselected.test.ts',
    );
    expect(await verify()).toEqual({ result: 'pass', passed: 1, failed: 0 });
    expect(fs.readdirSync(scratch)).toEqual([]);
  });
  it('distinguishes failing assertions from verifier infrastructure failures', async () => {
    source("import {it,expect} from 'vitest'; it('broken', () => expect(true).toBe(false));");
    expect(await verify()).toEqual({ result: 'fail', passed: 0, failed: 1 });
    source("throw new Error('cannot load suite');");
    await expect(verify()).rejects.toThrow(/infrastructure/);
    source("import {it} from 'vitest'; it.skip('unverified', () => {});");
    await expect(verify()).rejects.toThrow(/infrastructure/);
  });
  it.each(['', 'if (false) expect(true).toBe(true);'])(
    'fails QA when a test executes no assertion (%s)',
    async (body) => {
      // qaCommands owns the junction and validates its removal and the unchanged tree.
      fs.unlinkSync(link);
      git('init', '-b', 'main', '--separate-git-dir', path.join(root, 'metadata'));
      source("import { it, expect } from 'vitest'; it('no assertion', () => { " + body + ' });');
      git('add', 'server');
      git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-m',
        'fixture',
      );
      const input = {
        worktree: tree,
        reviewRef: { sha: git('rev-parse', 'HEAD').trim() },
        files: ['server/__tests__/check.test.ts'],
        task: { changeZones: [], testZones: [] },
      } as unknown as ReviewerRequest;
      expect(await qaCommands(input, scratch, new AbortController().signal)).toEqual([
        { command: 'vitest:server/__tests__/check.test.ts', result: 'fail', passed: 0, failed: 1 },
      ]);
      expect(fs.readdirSync(scratch)).toEqual([]);
      expect(fs.existsSync(link)).toBe(false);
      expect(git('status', '--porcelain', '--ignored').trim()).toBe('');
    },
  );
  it.each(['allure-results/output.json', '.vite/output.json'])(
    'reports a forbidden runtime write %s with escaped path and verification phase',
    async (file) => {
      fs.unlinkSync(link);
      git('init', '-b', 'main', '--separate-git-dir', path.join(root, 'metadata'));
      source(
        "import { it, expect } from 'vitest'; import fs from 'fs'; it('writes', () => { fs.mkdirSync(" +
          JSON.stringify(path.join(tree, path.dirname(file))) +
          ', { recursive: true }); fs.writeFileSync(' +
          JSON.stringify(path.join(tree, file)) +
          ", 'output'); expect(true).toBe(true); });",
      );
      git('add', 'server');
      git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-m',
        'fixture',
      );
      const input = {
        worktree: tree,
        reviewRef: { sha: git('rev-parse', 'HEAD').trim() },
        files: ['server/__tests__/check.test.ts'],
        task: { changeZones: [], testZones: [] },
      } as unknown as ReviewerRequest;
      await expect(qaCommands(input, scratch, new AbortController().signal)).rejects.toThrow(
        'cambio durante la verificación: Eval modified a forbidden path: ' + JSON.stringify(file),
      );
      expect(fs.existsSync(link)).toBe(false);
      expect(fs.readdirSync(scratch)).toEqual([]);
    },
  );
  it('selects changed, mirror and declared tests only, and rejects unbounded sets', () => {
    git('init', '-b', 'main', '--separate-git-dir', path.join(root, 'metadata'));
    source('// fixture');
    source('// fixture', 'server/__tests__/unrelated.test.ts');
    source('// fixture', 'server/__tests__/declared.test.ts');
    git('add', 'server');
    const input = {
      worktree: tree,
      files: [],
      task: {
        changeZones: ['server/src/check.ts'],
        testZones: ['server/__tests__/declared.test.ts'],
      },
    } as unknown as ReviewerRequest;
    expect(qaTestFiles(input)).toEqual([
      'server/__tests__/check.test.ts',
      'server/__tests__/declared.test.ts',
    ]);
    for (let i = 0; i < QA_MAX_TEST_FILES; i++)
      source('// fixture', 'server/__tests__/extra' + i + '.test.ts');
    git('add', 'server');
    input.task.testZones = ['server/__tests__/'];
    expect(() => qaTestFiles(input)).toThrow(/bounded/);
  });
  it('recovers QA without consuming rounds even when the lease expires before an Execution is created', async () => {
    git('init', '-b', 'main');
    const store = await openWorkStore({ repositoryPath: tree, projectId: 'test' });
    const key = 'FEAT-001-T01';
    store.createTask({ key, type: 'code', status: 'QA' });
    const db = new DatabaseSync(path.join(tree, '.git/softwareagents/work.sqlite3'));
    try {
      db.prepare('UPDATE tasks SET review_ref = ? WHERE key = ?').run(
        JSON.stringify({
          branch: 'sa/' + key + '-developer',
          sha: 'a'.repeat(40),
          base: 'b'.repeat(40),
        }),
        key,
      );
      await store.claimReview(key, store.getTask(key)!.version, 'qa-test', 'qa');
      expect(store.getTask(key)!.attempt).toBe(0);
      db.prepare('UPDATE tasks SET lease_expires_at = ? WHERE key = ?').run(
        new Date(0).toISOString(),
        key,
      );
      await store.recoverExpiredLeases();
      expect(store.getTask(key)).toMatchObject({ status: 'QA', attempt: 0, lease_owner: null });
    } finally {
      db.close();
      store.close();
    }
  });
  it('accepts explicit QA preferences and preserves review fallback for historical policies', () => {
    fs.mkdirSync(path.join(tree, '.softwareagents/agents'), { recursive: true });
    const file = path.join(tree, '.softwareagents/agents/model-policy.yaml');
    fs.writeFileSync(file, 'review:\n  - executor: claude\n');
    expect(loadModelPolicy(tree).test_analysis).toEqual([{ executor: 'claude' }]);
    fs.writeFileSync(file, 'review:\n  - executor: claude\ntest_analysis:\n  - executor: codex\n');
    expect(loadModelPolicy(tree).test_analysis).toEqual([{ executor: 'codex' }]);
  });
});
