import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { matchesChangeZone, validateChangeZone } from '../src/changeZones.js';
import { runFeatureCommand } from '../src/commands/feature.js';
import {
  type DeveloperRequest,
  guardDeveloperChanges,
  pushDeveloperBranch,
} from '../src/developer.js';
import { EXECUTOR_PROBE_CATALOG } from '../src/executorProbes.js';
import { guardProtectedPaths } from '../src/executors/protectedPaths.js';
import { WorktreeManager } from '../src/executors/worktreeManager.js';
import { checkCascadeCriteria } from '../src/modelCascade.js';
import { loadProjectConfig } from '../src/projectConfig.js';
import { taskBranchBase } from '../src/taskBranchBase.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import { readyProbeFor } from './helpers/readyProbe.js';

// Each case runs real Git plus a nested Vitest; under full-suite load on Windows this exceeds 30 s.
vi.setConfig({ testTimeout: 90_000 });
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));
let root: string;
let repo: string;
let launches: string;
let executor: 'claude' | 'codex';
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const task = 'FEAT-001-T01';
const tree = () => path.join(repo, '.worktrees', task);
const storeFor = () => openWorkStore({ repositoryPath: repo, projectId: 'test' });
function detachedTree(): string {
  const directory = path.join(root, 'guard-tree');
  git(repo, 'worktree', 'add', '--detach', directory, 'main');
  return directory;
}
function configure(
  push?: { enabled: boolean; remote: string },
  selected: 'claude' | 'codex' = 'claude',
) {
  executor = selected;
  fs.writeFileSync(
    path.join(root, '.pixel-agents/config.json'),
    JSON.stringify({
      projects: {
        test: {
          autonomyLevel: 'A1',
          allowedExecutors: [selected],
          binaryPaths: { [selected]: process.execPath },
          quotaThresholds: { [selected]: 0 },
          concurrency: { maxExecutions: 1, perExecutor: { [selected]: 1 } },
          ...(push ? { developer: { pushBranch: push } } : {}),
        },
      },
    }),
  );
}
const run = (command: string[], fixture = 'developer', mode = 'valid') =>
  runFeatureCommand(command, repo, () => {}, {
    binaryArgs: [
      path.join(__dirname, `fixtures/fake-${fixture}-cli.cjs`),
      executor,
      mode,
      launches,
    ],
    probe: readyProbeFor(EXECUTOR_PROBE_CATALOG),
  });
const develop = (mode = 'valid', explicit = true) =>
  run(['develop', 'FEAT-001', ...(explicit ? ['--task', task] : [])], 'developer', mode);
async function prepare(approve = true, design = true, designMode = 'valid') {
  await run(['spec', 'FEAT-001', '--request', 'request.md'], 'requirements');
  if (approve) await runFeatureCommand(['approve', 'FEAT-001'], repo, () => {});
  if (approve && design) await run(['design', 'FEAT-001'], 'architect', designMode);
  fs.writeFileSync(launches, '');
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'developer-'));
  repo = path.join(root, 'repo');
  launches = path.join(root, 'launches.jsonl');
  fs.mkdirSync(path.join(repo, '.softwareagents/agents'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.softwareagents/brain'), { recursive: true });
  fs.mkdirSync(path.join(root, '.pixel-agents'));
  for (const key of ['HOME', 'USERPROFILE']) vi.stubEnv(key, root);
  vi.stubEnv('CODEX_HOME', path.join(root, 'codex'));
  vi.stubEnv('SA_TEST_NO_RATE_LIMIT', '1');
  for (const key of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(key, undefined);
  for (const role of ['AUTHOR', 'COMMITTER']) {
    vi.stubEnv(`GIT_${role}_NAME`, 'Test');
    vi.stubEnv(`GIT_${role}_EMAIL`, 'test@example.invalid');
  }
  git(repo, 'init', '-b', 'main');
  fs.writeFileSync(
    path.join(repo, '.softwareagents/project.yaml'),
    'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: test\nname: Test\nrepo:\n  remote: https://example.invalid/test.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n',
  );
  fs.writeFileSync(
    path.join(repo, '.softwareagents/agents/model-policy.yaml'),
    'high_reasoning:\n  - executor: claude\n  - executor: codex\nstandard_coding:\n  - executor: claude\n  - executor: codex\n',
  );
  fs.writeFileSync(path.join(repo, 'request.md'), 'Audit view');
  fs.writeFileSync(
    path.join(repo, 'tsconfig.json'),
    '{"compilerOptions":{"noEmit":true},"include":["server/src/**/*.ts"]}',
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'fixture');
  configure();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
});

describe('Developer diff guard', () => {
  it('matches literal zones, directories and zero or more globstar directories', () => {
    expect(matchesChangeZone('src/a.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesChangeZone('src/nested/a.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesChangeZone('src/a.ts', 'src/*.ts')).toBe(true);
    expect(matchesChangeZone('src/nested/a.ts', 'src/*.ts')).toBe(false);
    expect(matchesChangeZone('src/a.ts', 'src')).toBe(false);
    expect(matchesChangeZone('src/a.ts', 'src/', true)).toBe(true);
    expect(matchesChangeZone('outside/a.ts', 'src/**')).toBe(false);
  });

  it('rejects a concrete protected descendant inside an otherwise valid directory zone', () => {
    fs.mkdirSync(path.join(repo, 'webview-ui/test'), { recursive: true });
    const zone = 'webview-ui/test';
    const config = loadProjectConfig(repo, true)!;
    config.operator.protectedPaths = ['**/.codex/**'];
    expect(() => validateChangeZone(repo, zone, config.operator.protectedPaths!)).not.toThrow();
    const base = git(repo, 'rev-parse', 'HEAD');
    const directory = detachedTree();
    const relative = 'webview-ui/test/.codex/x';
    expect(matchesChangeZone(relative, zone, true)).toBe(true);
    fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
    fs.writeFileSync(path.join(directory, relative), 'protected instructions');
    git(directory, 'add', '.');
    const input = { task: { changeZones: [zone] } } as DeveloperRequest;
    expect(() => guardDeveloperChanges(input, config, directory, base)).toThrow('forbidden path');
    const gate = guardProtectedPaths({
      cwd: directory,
      base,
      staged: true,
      operator: config.operator,
      projectId: 'test',
    });
    expect(gate.paths).toEqual([relative]);
    expect(gate.decision.outcome).not.toBe('allow');
    expect(git(directory, 'rev-parse', 'HEAD')).toBe(base);
  });

  it('requires actual test additions and rejects staged-only or deleted evidence', () => {
    fs.mkdirSync(path.join(repo, 'server/__tests__'), { recursive: true });
    const relative = 'server/__tests__/audit.test.ts';
    const original = "it('baseline', () => {});\n";
    fs.writeFileSync(path.join(repo, relative), original);
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'baseline test');
    const base = git(repo, 'rev-parse', 'HEAD');
    const guardTree = path.join(root, 'guard-tree');
    git(repo, 'worktree', 'add', '--detach', guardTree, 'main');
    const file = path.join(guardTree, relative);
    const input = { task: { changeZones: ['server/src/audit*.ts'] } } as DeveloperRequest;
    const check = () =>
      guardDeveloperChanges(input, loadProjectConfig(repo, true)!, guardTree, base);
    fs.appendFileSync(file, "it('acceptance', () => {});\n");
    expect(check).toThrow('requires an assertion');
    fs.writeFileSync(file, original + "it('acceptance', () => expect(true).toBe(true));\n");
    expect(check()).toEqual([relative]);
    git(guardTree, 'add', '.');
    fs.writeFileSync(file, original);
    expect(check).toThrow('requires an added or adjusted');
    fs.unlinkSync(file);
    expect(check).toThrow('requires an added or adjusted');
  });

  it.each(['delete', 'empty', 'disguised'])('rejects %s of a foreign test suite', (mode) => {
    const relative = 'server/__tests__/foreign.test.ts';
    fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
    fs.writeFileSync(path.join(repo, relative), "it('foreign', () => expect(true).toBe(true));\n");
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'foreign suite');
    const base = git(repo, 'rev-parse', 'HEAD');
    const directory = detachedTree();
    if (mode === 'delete') fs.unlinkSync(path.join(directory, relative));
    else
      fs.writeFileSync(
        path.join(directory, relative),
        mode === 'empty' ? '' : 'export const logic = 1;',
      );
    const input = { task: { changeZones: ['server/src/audit*.ts'] } } as DeveloperRequest;
    expect(() =>
      guardDeveloperChanges(input, loadProjectConfig(repo, true)!, directory, base),
    ).toThrow('changeZones exceeded');
  });

  it('allows explicit testZones, while suffixes alone grant no scope', () => {
    const base = git(repo, 'rev-parse', 'HEAD');
    const directory = detachedTree();
    const relative = 'integration/audit.test.ts';
    fs.mkdirSync(path.join(directory, 'integration'));
    fs.writeFileSync(
      path.join(directory, relative),
      "it('acceptance', () => expect(true).toBe(true));\n",
    );
    const input = { task: { changeZones: ['server/src/audit.ts'] } } as DeveloperRequest;
    const check = () =>
      guardDeveloperChanges(input, loadProjectConfig(repo, true)!, directory, base);
    expect(check).toThrow('changeZones exceeded');
    input.task.testZones = ['integration/audit.test.ts'];
    expect(check()).toEqual([relative]);
  });

  it.each([
    "it('empty', () => {});",
    "describe.skip('skipped', () => { it('test', () => expect(true).toBe(true)); });",
    "it.todo('later');",
    "it.only('focused', () => expect(true).toBe(true));",
    "it['skip']('skipped', () => expect(true).toBe(true));",
    "it('skipped', { skip: true }, () => expect(true).toBe(true));",
    "it.skipIf(true)('skipped', () => expect(true).toBe(true));",
  ])('rejects invalid test additions: %s', (source) => {
    const base = git(repo, 'rev-parse', 'HEAD');
    const directory = detachedTree();
    fs.mkdirSync(path.join(directory, 'server/__tests__'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'server/__tests__/audit.test.ts'), source);
    const input = { task: { changeZones: ['server/src/audit.ts'] } } as DeveloperRequest;
    expect(() =>
      guardDeveloperChanges(input, loadProjectConfig(repo, true)!, directory, base),
    ).toThrow(/assertion|skip\/todo\/only/);
  });

  it.each(['empty', 'skipped', 'missing', 'passed'])(
    'requires structured execution evidence per file: %s',
    async (mode) => {
      const base = git(repo, 'rev-parse', 'HEAD');
      const directory = detachedTree();
      fs.mkdirSync(path.join(directory, 'server/__tests__'), { recursive: true });
      const relative = 'server/__tests__/audit.test.ts';
      fs.writeFileSync(
        path.join(directory, relative),
        `import { it, expect, describe } from 'vitest';\n${
          mode === 'empty'
            ? "describe('empty', () => {});"
            : `it${mode === 'skipped' ? '.skip' : ''}('evidence', () => expect(true).toBe(true));`
        }`,
      );
      const result = await checkCascadeCriteria(
        { commands: [] },
        base,
        directory,
        root,
        new AbortController().signal,
        undefined,
        mode === 'missing' ? [relative, 'server/__tests__/missing.test.ts'] : [relative],
      );
      expect(result).toEqual([mode === 'passed' ? 'pass' : 'fail']);
    },
  );

  it('rejects preseeded branches without a trusted base, including outside commits', async () => {
    const branch = `sa/${task}-developer`;
    git(repo, 'checkout', '-b', branch);
    fs.writeFileSync(path.join(repo, 'outside.txt'), 'hidden outside changes');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'outside');
    git(repo, 'checkout', 'main');
    const manager = new WorktreeManager({
      repositoryPath: repo,
      defaultBranch: 'main',
      manualPreparation: true,
      trustedBase: true,
    });
    await expect(manager.create(task, 'developer')).rejects.toThrow('no registered trusted base');
    expect(fs.existsSync(tree())).toBe(false);
  });

  it('persists a trusted base and checks it on every retry', async () => {
    const manager = new WorktreeManager({
      repositoryPath: repo,
      defaultBranch: 'main',
      manualPreparation: true,
      trustedBase: true,
    });
    const base = git(repo, 'rev-parse', 'HEAD');
    expect((await manager.create(task, 'developer')).base).toBe(base);
    expect((await manager.create(task, 'developer')).base).toBe(base);
    fs.writeFileSync(path.join(repo, 'outside.txt'), 'new main');
    git(repo, 'add', 'outside.txt');
    git(repo, 'commit', '-m', 'main advanced');
    expect(taskBranchBase(repo, `sa/${task}-developer`, 'main')).toBe(base);
    git(tree(), 'reset', '--hard', 'main');
    await expect(manager.create(task, 'developer')).rejects.toThrow('merge-base differs');
  });
});

describe.skipIf(process.platform !== 'win32')('Developer via worker (fake CLI)', () => {
  it.each(['claude', 'codex'] as const)(
    'commits one eligible task via %s, records review_ref and retries without duplicate executions',
    async (selected) => {
      configure(undefined, selected);
      await prepare();
      const remote = path.join(root, 'remote.git');
      git(root, 'init', '--bare', remote);
      git(repo, 'remote', 'add', 'origin', remote);
      const main = git(repo, 'rev-parse', 'main');
      await develop('valid', false);
      const store = await storeFor();
      try {
        const record = store.getTask(task)!;
        expect(record.status).toBe('REVIEW');
        expect(record.review_ref).toMatchObject({
          branch: `sa/${task}-developer`,
          sha: git(tree(), 'rev-parse', 'HEAD'),
          base: main,
        });
        expect(git(tree(), 'log', '-1', '--format=%B')).toContain('SoftwareAgents-Execution:');
        expect(git(repo, 'rev-parse', 'main')).toBe(main);
        expect(store.getTask('FEAT-001-T02')?.status).toBe('DRAFT');
        const before = store.listExecutions();
        await develop();
        await develop('valid', false);
        expect(store.listExecutions()).toEqual(before);
        expect(git(tree(), 'rev-parse', 'HEAD')).toBe(record.review_ref!.sha);
        const log = vi.fn();
        await runFeatureCommand(['show', 'FEAT-001', '--json'], repo, log);
        expect(
          JSON.parse(log.mock.calls[0][0]).tasks.find((t: { key: string }) => t.key === task)
            .review_ref,
        ).toEqual(record.review_ref);
        const launch = JSON.parse(fs.readFileSync(launches, 'utf8').trim());
        const data = JSON.parse(launch.context.task.brief);
        expect(data.approvedSpec.acceptance[0].id).toBe('AC-001');
        expect(data.task.changeZones).toEqual(['server/src/audit*.ts']);
        expect(data.design).toContain('Technical design');
        expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe('');
        if (selected === 'codex')
          expect(launch.args[launch.args.indexOf('--sandbox') + 1]).toBe('workspace-write');
      } finally {
        store.close();
      }
    },
  );
  it('skips READY tasks with unfinished dependencies and develops only the first eligible code task', async () => {
    await prepare(true, true, 'developer-dependency');
    const store = await storeFor();
    try {
      expect(store.getTask(task)?.status).toBe('DRAFT');
      const record = store.getTask(task)!;
      await store.transition(task, record.version, 'READY', 'fixture', 'test');
      await expect(develop()).rejects.toThrow(/eligible READY/);
      await develop('valid', false);
      expect(store.getTask(task)?.status).toBe('READY');
      expect(store.getTask('FEAT-001-T02')?.status).toBe('REVIEW');
      expect(
        store
          .listExecutions()
          .filter((e) => e.agent_template_version && e.task_key.startsWith('FEAT-001-T')),
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  });
  it.each(['outside', 'no-test', 'bad-test', 'empty-test', 'unexecuted-assertion', 'skip-suite'])(
    'rejects %s without committing',
    async (mode) => {
      await prepare();
      const main = git(repo, 'rev-parse', 'main');
      await expect(develop(mode)).rejects.toThrow(/changeZones|test|verifier/i);
      expect(git(tree(), 'rev-parse', 'HEAD')).toBe(main);
      const store = await storeFor();
      try {
        expect(store.getTask(task)?.review_ref).toBeNull();
      } finally {
        store.close();
      }
    },
  );
  it('reevaluates WAITING_QUOTA through lifecycle recovery', async () => {
    await prepare();
    const store = await storeFor();
    try {
      let record = store.getTask(task)!;
      await store.transition(task, record.version, 'WAITING_QUOTA', 'quota wait', 'test');
      await develop();
      record = store.getTask(task)!;
      expect(record.status).toBe('REVIEW');
      expect(record.review_ref?.base).toBe(git(repo, 'rev-parse', 'main'));
    } finally {
      store.close();
    }
  });
  it.each(['unapproved', 'missing-design', 'changed-design', 'blocked-task'])(
    'rejects %s before launching',
    async (mode) => {
      await prepare(mode !== 'unapproved', mode !== 'missing-design');
      if (mode === 'changed-design')
        fs.appendFileSync(
          path.join(
            repo,
            '.worktrees/FEAT-001/.softwareagents/brain/technical-designs/FEAT-001.md',
          ),
          '\nchanged',
        );
      if (mode === 'blocked-task') {
        const store = await storeFor();
        try {
          const t = store.getTask(task)!;
          await store.transition(task, t.version, 'BLOCKED', 'test', 'test');
        } finally {
          store.close();
        }
      }
      await expect(develop()).rejects.toThrow(/approved|design|SHA|eligible|READY/i);
      expect(fs.readFileSync(launches, 'utf8')).toBe('');
    },
  );
  it('pushes only the task ref to an explicit resolved URL, once, when enabled', async () => {
    await prepare();
    const remote = path.join(root, 'remote.git');
    git(root, 'init', '--bare', remote);
    // Even a remote named main cannot become the destination branch.
    git(repo, 'remote', 'add', 'main', remote);
    configure({ enabled: true, remote: 'main' });
    await develop();
    await develop();
    expect(git(remote, 'rev-parse', `refs/heads/sa/${task}-developer`)).toBe(
      git(tree(), 'rev-parse', 'HEAD'),
    );
    expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe(
      `refs/heads/sa/${task}-developer`,
    );
    const store = await storeFor();
    try {
      expect(store.listExecutions().filter((e) => e.task_key === task)).toHaveLength(1);
      const review = store.getTask(task)!.review_ref!;
      await expect(
        pushDeveloperBranch(store, loadProjectConfig(repo, true)!, task, {
          ...review,
          branch: 'main',
        }),
      ).rejects.toThrow('push_main = deny');
      expect(git(repo, 'rev-parse', 'main')).toBe(review.base);
      git(repo, 'remote', 'add', 'broken', path.join(root, 'missing.git'));
      const config = loadProjectConfig(repo, true)!;
      config.operator.developer!.pushBranch.remote = 'broken';
      await expect(pushDeveloperBranch(store, config, task, review)).rejects.toThrow(
        'local review_ref retained',
      );
      await expect(pushDeveloperBranch(store, config, task, review)).rejects.toThrow(
        'pending or uncertain',
      );
      expect(store.getTask(task)?.review_ref).toEqual(review);
    } finally {
      store.close();
    }
  });
});
