import { DatabaseSync } from 'node:sqlite';

import { execFileSync, spawn } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as architect from '../src/architect.js';
import { AuditLog } from '../src/auditLog.js';
import { runFeatureCommand } from '../src/commands/feature.js';
import { EXECUTOR_PROBE_CATALOG } from '../src/executorProbes.js';
import { assertFeatureRunIngress, type FeatureRunSummary, runFeature } from '../src/featureRun.js';
import { assertTaskDependencies } from '../src/featureRunBase.js';
import { publishDirectRef } from '../src/gitPublication.js';
import { loadProjectConfig } from '../src/projectConfig.js';
import { lastReviewFailure } from '../src/reviewAttempts.js';
import { reviewerDecision } from '../src/reviewer.js';
import { taskBranchBase, taskBranchBaseFile } from '../src/taskBranchBase.js';
import { recoverFeatureTaskRebase } from '../src/taskRebase.js';
import { VERIFIER_INFRASTRUCTURE_PREFIX } from '../src/verifierInfrastructure.js';
import * as processRecovery from '../src/workstore/processRecovery.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import type { WorkStore } from '../src/workstore/WorkStore.js';
import { developerVerifierConfig } from './helpers/developerVerifierConfig.js';
import { readyProbeFor } from './helpers/readyProbe.js';

vi.setConfig({ testTimeout: 300_000 });
// Style is covered with real tools in developerCli/qaCli. Keep these scheduling cases
// within the 90 s budget while retaining real acceptance-test execution and Git.
vi.mock('../src/developer.js', async (original) => {
  const actual = await original<typeof import('../src/developer.js')>();
  return {
    ...actual,
    developerStyleCommands: (tree: string, base: string, fix?: boolean) =>
      fs.existsSync(path.join(tree, 'docs/guide.md'))
        ? actual.developerStyleCommands(tree, base, fix)
        : [],
    developerVerifier: () => ({ commands: [] }),
  };
});
// The real Windows identity/termination boundary has its own suite and the separate
// kill/restart harness below. Avoid dozens of PowerShell startups in scheduler cases.
vi.mock('../src/workstore/processRecovery.js', async (original) => {
  const actual = await original<typeof import('../src/workstore/processRecovery.js')>();
  return {
    ...actual,
    processStartIdentity: async (pid: number) => {
      try {
        process.kill(pid, 0);
        return '123456789';
      } catch {
        return null;
      }
    },
    terminateExecutionTree: async (pid: number, identity: string) => {
      if (identity !== '123456789') return actual.terminateExecutionTree(pid, identity);
      // Only fixture supervisor roots registered under the synthetic identity.
      try {
        process.kill(pid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    },
  };
});
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));
let root: string;
let repo: string;
let launches: string;
const feature = 'FEAT-001';
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
const storeFor = () => openWorkStore({ repositoryPath: repo, projectId: 'test' });
const options = (scenario = 'valid') => ({
  binaryArgs: [path.join(__dirname, 'fixtures/fake-feature-run-cli.cjs'), scenario, launches],
  probe: readyProbeFor(EXECUTOR_PROBE_CATALOG),
});
const run = async (scenario = 'valid', args: string[] = []) => {
  let summary!: FeatureRunSummary;
  await runFeatureCommand(
    ['run', feature, ...args, '--json'],
    repo,
    (line) => {
      summary = JSON.parse(line) as FeatureRunSummary;
    },
    options(scenario),
  );
  if (['failed', 'interrupted'].includes(summary.status)) {
    const store = await storeFor();
    try {
      // Include recovery evidence in assertion failures when Windows helpers are
      // denied by the sandbox. Never bypass process-closure checks to pass a test.
      summary.message += `; recovery diagnostics: ${JSON.stringify({
        leases: store.listLeaseRecoveries(),
        events: store.listTasks().flatMap((task) => store.listDomainEvents(task.key)),
        pending: store.listWorkerPublications(feature).map((p) => p.task),
      })}`;
    } finally {
      store.close();
    }
  }
  return summary;
};
const rows = () =>
  fs
    .readFileSync(launches, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(
      (row) =>
        JSON.parse(row) as { role: string; task?: string; data: { previousFailure?: unknown } },
    );
async function spec(approve = true) {
  await runFeatureCommand(['spec', feature, '--request', 'request.md'], repo, () => {}, options());
  if (approve) await runFeatureCommand(['approve', feature], repo, () => {});
}
beforeEach(async (context) => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-run-'));
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
  git('init', '-b', 'main');
  developerVerifierConfig(repo);
  fs.writeFileSync(
    path.join(repo, '.softwareagents/project.yaml'),
    'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: test\nname: Test\nrepo:\n  remote: https://example.invalid/test.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n',
  );
  fs.writeFileSync(
    path.join(repo, '.softwareagents/agents/model-policy.yaml'),
    'high_reasoning:\n  - executor: claude\nstandard_coding:\n  - executor: claude\nreview:\n  - executor: codex\n  - executor: claude\n',
  );
  fs.writeFileSync(path.join(repo, 'request.md'), 'Audit view');
  fs.writeFileSync(
    path.join(repo, 'tsconfig.json'),
    '{"compilerOptions":{"noEmit":true},"include":["server/src/**/*.ts"]}',
  );
  git('add', '.');
  git('commit', '-m', 'fixture');
  fs.writeFileSync(
    path.join(root, '.pixel-agents/config.json'),
    JSON.stringify({
      projects: {
        test: {
          autonomyLevel: 'A1',
          allowedExecutors: ['claude', 'codex'],
          binaryPaths: { claude: process.execPath, codex: process.execPath },
          quotaThresholds: { claude: 0, codex: 0 },
          concurrency: { maxExecutions: 1, perExecutor: { claude: 1, codex: 1 } },
        },
      },
    }),
  );
  if (context.task.name.startsWith('completes three dependent tasks')) {
    // Approved spec and design are durable fixtures, outside the task-execution budget.
    await spec();
    await runFeatureCommand(['design', feature], repo, () => {}, options());
  }
}, 90_000);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
});

// Exercise the scheduler without an Executor or Windows process helpers, so the
// distinction between a worker diagnostic and a runner signal is always tested.
describe('feature run interruption authority', () => {
  it.each(['server/src', 'core/asyncapi.yaml'])(
    'waits before develop for another feature, then reevaluates %s without an attempt',
    async (zone) => {
      const store = await storeFor();
      const db = new DatabaseSync(path.join(repo, '.git/softwareagents/work.sqlite3'));
      try {
        const main = git('rev-parse', 'main');
        for (const key of ['FEAT-001', 'FEAT-002']) {
          store.createFeature({ key, doc_path: 'request.md', git_sha: main, status: 'approved' });
          store.createTask({
            key: `${key}-T01`,
            feature_key: key,
            type: 'code',
            status: 'READY',
            declaration: JSON.stringify({ changeZones: [zone] }),
          });
        }
        db.prepare('UPDATE tasks SET declaration = ?').run(JSON.stringify({ changeZones: [zone] }));
        db.prepare(
          // A live orchestrator (this process) holds FEAT-001; a dead one would hold nothing.
          'INSERT INTO feature_runs (project_id, feature_key, owner, pid, state) VALUES (?, ?, ?, ?, ?)',
        ).run(
          'test',
          'FEAT-001',
          'feature-run-other',
          process.pid,
          JSON.stringify({
            branch: 'sa/FEAT-001-integration',
            head: main,
            initial_main: main,
            request: 'request.md',
            integrated: {},
            status: 'running',
            startedAt: '2020-01-01T00:00:00Z',
          }),
        );
        vi.spyOn(store, 'getDesign').mockReturnValue({
          project_id: 'test',
          feature_key: 'FEAT-002',
          doc_path: 'design.md',
          dag_path: 'dag.yaml',
          git_sha: main,
          feature_sha: main,
        });
        const invoke = vi.fn(async () => {
          db.prepare("UPDATE tasks SET status = 'WAITING_HUMAN' WHERE key = 'FEAT-002-T01'").run();
        });
        let waited = false;
        const result = await runFeature(
          store,
          loadProjectConfig(repo, true)!,
          'FEAT-002',
          undefined,
          invoke,
          (line) => {
            if (!line.startsWith('zone conflict:')) return;
            waited = true;
            expect(invoke).not.toHaveBeenCalled();
            expect(store.getTask('FEAT-002-T01')!.attempt).toBe(0);
            expect(store.getFeatureRun('FEAT-002')!.state.zoneWait?.reason).toBe(line);
            db.prepare("UPDATE tasks SET status = 'DONE' WHERE key = 'FEAT-001-T01'").run();
          },
        );
        expect(waited).toBe(true);
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(result.status).toBe('WAITING_HUMAN');
        expect(store.getFeatureRun('FEAT-002')!.state.zoneWait).toBeUndefined();
      } finally {
        db.close();
        store.close();
      }
    },
  );
  it.each(['WAITING_HUMAN', 'FAILED_FINAL', 'WAITING_QUOTA', 'DONE'])(
    'schedules A to C and independent B after current A becomes %s',
    async (status) => {
      const store = await storeFor();
      const db = new DatabaseSync(path.join(repo, '.git/softwareagents/work.sqlite3'));
      try {
        const main = git('rev-parse', 'main');
        store.createFeature({
          key: feature,
          doc_path: 'request.md',
          git_sha: main,
          status: 'approved',
        });
        vi.spyOn(store, 'getDesign').mockReturnValue({
          project_id: 'test',
          feature_key: feature,
          doc_path: 'design.md',
          dag_path: 'dag.yaml',
          git_sha: main,
          feature_sha: main,
        });
        for (const suffix of ['A', 'B', 'C'])
          store.createTask({
            key: `${feature}-${suffix}`,
            feature_key: feature,
            type: 'code',
            status: 'READY',
            declaration: '{}',
          });
        store.addTaskDependency(`${feature}-C`, `${feature}-A`);
        db.prepare("UPDATE tasks SET declaration = '{}' WHERE feature_key = ?").run(feature);
        const invoke = vi.fn(async (args: string[]) => {
          const task = args.at(-1)!;
          const next = task.endsWith('-A') ? status : 'DONE';
          const branch = `sa/${task}-developer`;
          if (next === 'DONE') {
            taskBranchBase(repo, branch, `sa/${feature}-integration`, true);
            git('branch', branch, main);
            const tree = path.join(root, task);
            git('worktree', 'add', tree, branch);
            db.prepare('UPDATE tasks SET worktree_ref = ? WHERE key = ?').run(tree, task);
          }
          db.prepare(
            'UPDATE tasks SET status = ?, version = version + 1, review_ref = ?, blocked_reason = ? WHERE key = ?',
          ).run(
            next,
            next === 'DONE' ? JSON.stringify({ branch, sha: main, base: main }) : null,
            next === 'DONE' ? null : 'current fixture gate',
            task,
          );
          if (next === 'WAITING_QUOTA') process.exitCode = 3;
        });
        const result = await runFeature(
          store,
          loadProjectConfig(repo, true)!,
          feature,
          undefined,
          invoke,
          () => {},
        );
        const launched = invoke.mock.calls.map(([args]) => args.at(-1));
        if (status === 'DONE') {
          expect(launched, result.message).toEqual([
            `${feature}-A`,
            `${feature}-B`,
            `${feature}-C`,
          ]);
          expect(result).toMatchObject({ status: 'ready_to_merge', exit_code: 0, blocked: [] });
        } else if (status === 'WAITING_QUOTA') {
          expect(launched).toEqual([`${feature}-A`]);
          expect(result).toMatchObject({ status, exit_code: 3 });
        } else {
          expect(launched).toEqual([`${feature}-A`, `${feature}-B`]);
          expect(result).toMatchObject({ status: 'WAITING_HUMAN', exit_code: 3 });
          expect(result.blocked.map((b) => b.task)).toEqual([`${feature}-A`, `${feature}-C`]);
          expect(result.tasks.find((t) => t.key.endsWith('-B'))).toMatchObject({
            status: 'DONE',
            integrated: true,
          });
        }
      } finally {
        db.close();
        store.close();
      }
    },
  );
  it.each(['WAITING_HUMAN', 'FAILED_FINAL', 'WAITING_QUOTA'])(
    'advances independent tasks while respecting %s',
    async (status) => {
      await spec();
      // The design itself declares T02 independent and T03 dependent on T01.
      await runFeatureCommand(['design', feature], repo, () => {}, options('independent'));
      const db = new DatabaseSync(path.join(repo, '.git/softwareagents/work.sqlite3'));
      try {
        db.prepare('UPDATE tasks SET status = ?, blocked_reason = ? WHERE key = ?').run(
          status,
          'fixture gate',
          'FEAT-001-T01',
        );
      } finally {
        db.close();
      }
      if (status === 'WAITING_QUOTA') {
        const file = path.join(root, '.pixel-agents/config.json');
        const config = JSON.parse(fs.readFileSync(file, 'utf8'));
        config.projects.test.concurrency.perExecutor.claude = 0;
        fs.writeFileSync(file, JSON.stringify(config));
      }
      const result = await run('independent');
      expect(result.status, result.message).toBe(
        status === 'WAITING_QUOTA' ? status : 'WAITING_HUMAN',
      );
      expect(result.exit_code).toBe(3);
      const executed = rows()
        .filter((r) => r.role === 'developer')
        .map((r) => r.task);
      if (status === 'WAITING_QUOTA') expect(executed).toEqual([]);
      else {
        expect(executed, result.message).toEqual(['FEAT-001-T02']);
        expect(result.tasks.find((t) => t.key === 'FEAT-001-T02')).toMatchObject({
          status: 'DONE',
          integrated: true,
        });
        expect(result.blocked.map((b) => b.task)).toEqual(['FEAT-001-T01', 'FEAT-001-T03']);
        expect(result.blocked[1].reason).toContain('Blocked dependency');
        expect(result.message).toContain('pixel-agents task retry FEAT-001-T01');
      }
    },
  );
  it('supersedes a historical QA failure after an operator reset or subsequent retry', async () => {
    const store = await storeFor();
    try {
      const key = 'FEAT-001-T01';
      store.createTask({ key, type: 'code', status: 'REVIEW' });
      const failure = await store.transition(
        key,
        store.getTask(key)!.version,
        'QA',
        'QA failed: Unsupported QA test root',
        'worker',
      );
      expect(lastReviewFailure(store, failure)?.reason).toContain('Unsupported QA test root');
      const ready = await store.transition(
        key,
        failure.version,
        'READY',
        'Operator reset',
        'human',
      );
      expect(lastReviewFailure(store, ready)).toBeNull();
      await store.claim(key, 'retry-worker');
      const failed = await store.transition(
        key,
        store.getTask(key)!.version,
        'FAILED_RETRYABLE',
        'Developer retry failed',
        'retry-worker',
      );
      expect(lastReviewFailure(store, failed)).toBeNull();
      expect(
        store.listDomainEvents(key).some((event) => event.reason.startsWith('QA failed:')),
      ).toBe(true);
    } finally {
      store.close();
    }
  });
  it.each([false, true])(
    'recovers a main reconciliation intent already published=%s without losing its base',
    async (published) => {
      const store = await storeFor();
      try {
        const base = git('rev-parse', 'main');
        const branch = 'sa/FEAT-001-integration';
        git('branch', branch, base);
        fs.writeFileSync(path.join(repo, 'new-main.txt'), 'main advancement\n');
        git('add', 'new-main.txt');
        git('commit', '-m', 'main fixture');
        const main = git('rev-parse', 'main');
        store.createFeature({
          key: feature,
          doc_path: 'request.md',
          git_sha: base,
          status: 'in_review',
        });
        await store.claimFeatureRun(feature, 'interrupted', {
          branch,
          initial_main: base,
          head: base,
          request: 'request.md',
          integrated: {},
          attempts: {},
          status: 'running',
          pending: { task: 'main', before: base, after: main, main },
        });
        await store.releaseFeatureRun(feature, 'interrupted');
        if (published) publishDirectRef(repo, `refs/heads/${branch}`, main, base);
        const invoke = vi.fn(async () => {});
        const result = await runFeature(
          store,
          loadProjectConfig(repo, true)!,
          feature,
          undefined,
          invoke,
          () => {},
        );
        expect(result.status, result.message).toBe('WAITING_HUMAN');
        expect(store.getFeatureRun(feature)?.state).toMatchObject({
          initial_main: main,
          head: main,
        });
        expect(store.getFeatureRun(feature)?.state.pending).toBeUndefined();
        expect(git('rev-parse', branch)).toBe(main);
        expect(git('rev-parse', 'main')).toBe(main);
        expect(invoke).not.toHaveBeenCalled();
      } finally {
        store.close();
      }
    },
  );
  it('publishes direct refs with CAS and preserves main when the expected tip is stale', () => {
    const main = git('rev-parse', 'main');
    const next = git('commit-tree', `${main}^{tree}`, '-p', main, '-m', 'task fixture');
    const ref = 'refs/heads/sa/FEAT-001-T01-developer';
    fs.writeFileSync(
      path.join(repo, '.git/hooks/reference-transaction'),
      '#!/bin/sh\necho unexpected-hook > hook-ran\n',
      { mode: 0o755 },
    );
    publishDirectRef(repo, ref, main, '0'.repeat(main.length));
    publishDirectRef(repo, ref, next, main);
    expect(() => publishDirectRef(repo, ref, main, main)).toThrow();
    expect(git('rev-parse', ref)).toBe(next);
    expect(git('rev-parse', 'main')).toBe(main);
    expect(fs.existsSync(path.join(repo, 'hook-ran'))).toBe(false);
  });
  it('gates conflicting main advancement and retains the integration checkpoint on resume', async () => {
    const store = await storeFor();
    try {
      const main = git('rev-parse', 'main');
      const state = await store.claimFeatureRun(feature, 'fixture', {
        branch: 'sa/FEAT-001-integration',
        initial_main: main,
        head: main,
        request: 'request.md',
        integrated: {},
        attempts: {},
        status: 'running',
      });
      git('checkout', '-b', state.branch);
      fs.writeFileSync(path.join(repo, 'request.md'), 'integration edit\n');
      git('add', 'request.md');
      git('commit', '-m', 'integration fixture');
      state.head = git('rev-parse', 'HEAD');
      await store.saveFeatureRun(feature, 'fixture', state);
      await store.releaseFeatureRun(feature, 'fixture');
      git('checkout', 'main');
      fs.writeFileSync(path.join(repo, 'request.md'), 'main edit\n');
      git('add', 'request.md');
      git('commit', '-m', 'main fixture');
      const advanced = git('rev-parse', 'main');
      const invoke = vi.fn(async () => {});
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await runFeature(
          store,
          loadProjectConfig(repo, true)!,
          feature,
          undefined,
          invoke,
          () => {},
        );
        expect(result.status, result.message).toBe('WAITING_HUMAN');
        expect(result.message).toContain('merge conflict');
        expect(git('rev-parse', state.branch)).toBe(state.head);
        expect(git('rev-parse', 'main')).toBe(advanced);
        expect(store.getFeatureRun(feature)?.state.initial_main).toBe(main);
      }
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
  it.each(['sa/FEAT-001-integration', 'sa/FEAT-001-T01-developer'])(
    'rejects symbolic publication ref %s without moving main',
    async (branch) => {
      const main = git('rev-parse', 'main');
      git('symbolic-ref', `refs/heads/${branch}`, 'refs/heads/main');
      expect(() => publishDirectRef(repo, `refs/heads/${branch}`, main, main)).toThrow('Symbolic');
      const store = await storeFor();
      try {
        const invoke = vi.fn(async () => {});
        if (branch.endsWith('integration')) {
          const result = await runFeature(
            store,
            loadProjectConfig(repo, true)!,
            feature,
            'request.md',
            invoke,
            () => {},
          );
          expect(result.status).toBe('failed');
          expect(result.message).toContain('Symbolic');
          expect(invoke).not.toHaveBeenCalled();
        } else {
          expect(() => taskBranchBase(repo, branch, 'main', true)).toThrow('Symbolic');
        }
        expect(git('rev-parse', 'main')).toBe(main);
        expect(git('symbolic-ref', `refs/heads/${branch}`)).toBe('refs/heads/main');
      } finally {
        store.close();
      }
    },
  );
  const publishSpec = (store: WorkStore) =>
    store.createFeature({
      key: feature,
      doc_path: '.softwareagents/brain/features/FEAT-001.yaml',
      git_sha: git('rev-parse', 'main'),
      status: 'in_review',
    });
  const claim = async (store: WorkStore) => {
    const task = await store.claim(feature, 'fixture-worker');
    return store.transition(feature, task.version, 'RUNNING', 'Fixture launch', 'fixture-worker');
  };
  it('stops a command that creates neither a task nor an artifact without a retry loop', async () => {
    const store = await storeFor();
    try {
      const invoke = vi.fn(async () => {});
      expect(
        await runFeature(
          store,
          loadProjectConfig(repo, true)!,
          feature,
          undefined,
          invoke,
          () => {},
        ),
      ).toMatchObject({
        status: 'WAITING_HUMAN',
        message: expect.stringContaining('made no progress'),
      });
      expect(invoke).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });
  it('can resume QA not_tested repeatedly despite an exhausted legacy checkpoint', async () => {
    const store = await storeFor();
    const db = new DatabaseSync(path.join(repo, '.git/softwareagents/work.sqlite3'));
    const key = 'FEAT-001-T01';
    try {
      const main = git('rev-parse', 'main');
      const review = { branch: `sa/${key}-developer`, sha: main, base: main };
      git('branch', review.branch, main);
      store.createFeature({
        key: feature,
        doc_path: 'request.md',
        git_sha: main,
        status: 'approved',
      });
      store.createTask({
        key,
        feature_key: feature,
        type: 'code',
        agent_role: 'developer',
        status: 'QA',
        declaration: '{}',
        max_attempts: 1,
      });
      db.prepare("UPDATE tasks SET review_ref = ?, declaration = '{}' WHERE key = ?").run(
        JSON.stringify(review),
        key,
      );
      vi.spyOn(store, 'getDesign').mockReturnValue({
        project_id: 'test',
        feature_key: feature,
        doc_path: 'design.md',
        dag_path: 'dag.yaml',
        git_sha: main,
        feature_sha: main,
      });
      await store.claimFeatureRun(feature, 'legacy', {
        branch: `sa/${feature}-integration`,
        initial_main: main,
        head: main,
        request: 'request.md',
        integrated: {},
        attempts: { [`qa/${key}/${main}`]: 99 },
        published: { [key]: main },
        status: 'failed',
      });
      await store.releaseFeatureRun(feature, 'legacy');
      const invoke = vi.fn(async () => {
        db.prepare('UPDATE tasks SET version = version + 1, test_reports = ? WHERE key = ?').run(
          JSON.stringify([
            {
              report: {
                verdict: 'not_tested',
                commands: [
                  {
                    command: 'vitest:server/__tests__/hooks.test.ts',
                    result: 'not_tested',
                    reason: 'server build unavailable',
                  },
                ],
              },
            },
          ]),
          key,
        );
      });
      for (let i = 1; i <= 4; i++) {
        expect(
          await runFeature(
            store,
            loadProjectConfig(repo, true)!,
            feature,
            undefined,
            invoke,
            () => {},
          ),
        ).toMatchObject({
          status: 'WAITING_HUMAN',
          exit_code: 3,
          message: expect.stringContaining('server build unavailable'),
        });
        expect(invoke).toHaveBeenCalledTimes(i);
        expect(store.getTask(key)).toMatchObject({ status: 'QA', attempt: 0, review_ref: review });
        expect(store.getFeatureRun(feature)?.state.attempts).toBeUndefined();
      }
    } finally {
      db.close();
      store.close();
    }
  });
  it('ignores exhausted legacy run counters after an operator task reset', async () => {
    const store = await storeFor();
    try {
      store.createTask({ key: feature, type: 'unknown', status: 'READY', max_attempts: 1 });
      const first = await claim(store);
      const failed = await store.transition(
        feature,
        first.version,
        'FAILED_RETRYABLE',
        'Fixture agent failure',
        'fixture-worker',
      );
      await store.transition(feature, failed.version, 'READY', 'Operator reset', 'operator');
      const main = git('rev-parse', 'main');
      await store.claimFeatureRun(feature, 'legacy', {
        branch: `sa/${feature}-integration`,
        initial_main: main,
        head: main,
        request: 'request.md',
        integrated: {},
        attempts: { [`spec/${feature}/draft`]: 99 },
        status: 'failed',
      });
      await store.releaseFeatureRun(feature, 'legacy');
      const invoke = vi.fn(async () => {
        const task = await claim(store);
        publishSpec(store);
        await store.transition(
          feature,
          task.version,
          'REVIEW',
          'Fixture persisted',
          'fixture-worker',
        );
      });
      expect(
        await runFeature(
          store,
          loadProjectConfig(repo, true)!,
          feature,
          undefined,
          invoke,
          () => {},
        ),
      ).toMatchObject({ status: 'WAITING_HUMAN', exit_code: 3 });
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(store.getFeatureRun(feature)?.state.attempts).toBeUndefined();
    } finally {
      store.close();
    }
  });
  it('bounds proposal retries from task history without an independent run budget', async () => {
    const store = await storeFor();
    try {
      store.createTask({ key: feature, type: 'unknown', status: 'READY', max_attempts: 2 });
      const invoke = vi.fn(async () => {
        const task = await claim(store);
        await store.transition(
          feature,
          task.version,
          'FAILED_RETRYABLE',
          'Fixture agent failure',
          'fixture-worker',
        );
      });
      const config = loadProjectConfig(repo, true)!;
      for (let i = 0; i < 2; i++) {
        expect(await runFeature(store, config, feature, undefined, invoke, () => {})).toMatchObject(
          { status: 'failed', message: expect.stringContaining('max_attempts exhausted') },
        );
        expect(invoke).toHaveBeenCalledTimes(2);
      }
    } finally {
      store.close();
    }
  });
  it('stops infrastructure failures immediately and permits explicit resume without spending attempts', async () => {
    const store = await storeFor();
    try {
      store.createTask({ key: feature, type: 'unknown', status: 'READY', max_attempts: 1 });
      const invoke = vi.fn(async () => {
        const task = await claim(store);
        await store.transition(
          feature,
          task.version,
          'FAILED_RETRYABLE',
          VERIFIER_INFRASTRUCTURE_PREFIX + 'timeout',
          'fixture-worker',
        );
        throw new Error('verifier timeout');
      });
      for (let i = 1; i <= 4; i++) {
        expect(
          await runFeature(
            store,
            loadProjectConfig(repo, true)!,
            feature,
            undefined,
            invoke,
            () => {},
          ),
        ).toMatchObject({
          status: 'WAITING_HUMAN',
          exit_code: 3,
          message: expect.stringContaining('Verifier infrastructure: timeout'),
        });
        expect(invoke).toHaveBeenCalledTimes(i);
        expect(store.getTask(feature)!.attempt).toBe(0);
      }
    } finally {
      store.close();
    }
  });
  it('stops after recovering an unconfirmed verifier and resumes only on the next run', async () => {
    const store = await storeFor();
    const db = new DatabaseSync(path.join(repo, '.git/softwareagents/work.sqlite3'));
    try {
      store.createTask({ key: feature, type: 'unknown', status: 'READY', max_attempts: 1 });
      await claim(store);
      await store.markVerifierInfrastructureFailure(feature, 'fixture-worker');
      db.prepare('UPDATE tasks SET lease_expires_at = ? WHERE key = ?').run(
        new Date(0).toISOString(),
        feature,
      );
      const invoke = vi.fn(async () => {
        const task = await claim(store);
        publishSpec(store);
        await store.transition(
          feature,
          task.version,
          'REVIEW',
          'Fixture persisted',
          'fixture-worker',
        );
      });
      const config = loadProjectConfig(repo, true)!;
      expect(await runFeature(store, config, feature, undefined, invoke, () => {})).toMatchObject({
        status: 'WAITING_HUMAN',
        message: expect.stringContaining('SA-026 recovery required'),
      });
      expect(invoke).not.toHaveBeenCalled();
      expect(store.getTask(feature)).toMatchObject({ status: 'FAILED_RETRYABLE', attempt: 0 });
      expect(await runFeature(store, config, feature, undefined, invoke, () => {})).toMatchObject({
        status: 'WAITING_HUMAN',
        message: expect.stringContaining('Review the spec'),
      });
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(store.getTask(feature)!.attempt).toBe(0);
    } finally {
      db.close();
      store.close();
    }
  });
  it('retries a cancelled worker diagnostic without treating it as an operator signal', async () => {
    const store = await storeFor();
    try {
      store.createTask({ key: feature, type: 'unknown', status: 'READY' });
      const invoke = vi.fn(async () => {
        const task = await claim(store);
        if (invoke.mock.calls.length === 1) {
          await store.transition(
            feature,
            task.version,
            'FAILED_RETRYABLE',
            'Worker failed (category=cancelled; exit_code=unknown)',
            'fixture-worker',
          );
          throw new Error('injected publication interruption');
        }
        publishSpec(store);
        await store.transition(
          feature,
          task.version,
          'REVIEW',
          'Fixture persisted',
          'fixture-worker',
        );
      });
      const result = await runFeature(
        store,
        loadProjectConfig(repo, true)!,
        feature,
        'request.md',
        invoke,
        () => {},
      );
      expect(result).toMatchObject({ status: 'WAITING_HUMAN', exit_code: 3 });
      expect(result.message).toContain('Review the spec');
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally {
      store.close();
    }
  });
  it.each([
    ['SIGINT', false],
    ['SIGTERM', false],
    ['SIGINT', true],
    ['SIGTERM', true],
  ] as const)(
    'stops on runner %s even if the worker succeeds=%s, then permits resume',
    async (signal, succeeds) => {
      const store = await storeFor();
      const listeners = process.listenerCount(signal);
      try {
        store.createTask({ key: feature, type: 'unknown', status: 'READY' });
        const invoke = vi.fn(async () => {
          const task = await claim(store);
          publishSpec(store);
          await store.transition(
            feature,
            task.version,
            succeeds ? 'REVIEW' : 'FAILED_RETRYABLE',
            'Fixture persisted; category=executor; exit_code=unknown',
            'fixture-worker',
          );
          process.emit(signal);
          if (!succeeds) throw new Error('publication failed without a cancellation diagnostic');
        });
        const config = loadProjectConfig(repo, true)!;
        expect(
          await runFeature(store, config, feature, 'request.md', invoke, () => {}),
        ).toMatchObject({
          status: 'interrupted',
          exit_code: 130,
        });
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(store.getFeatureRun(feature)?.owner).toBeNull();
        expect(process.listenerCount(signal)).toBe(listeners);
        expect(await runFeature(store, config, feature, undefined, invoke, () => {})).toMatchObject(
          {
            status: 'WAITING_HUMAN',
            exit_code: 3,
          },
        );
        expect(invoke).toHaveBeenCalledTimes(1);
      } finally {
        store.close();
      }
    },
  );
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'stops on %s during recovery before launching a role',
    async (signal) => {
      const store = await storeFor();
      const listeners = process.listenerCount(signal);
      try {
        vi.spyOn(store, 'recoverExpiredLeases').mockImplementationOnce(async () => {
          process.emit(signal);
          return [];
        });
        const invoke = vi.fn();
        expect(
          await runFeature(
            store,
            loadProjectConfig(repo, true)!,
            feature,
            'request.md',
            invoke,
            () => {},
          ),
        ).toMatchObject({
          status: 'interrupted',
          exit_code: 130,
        });
        expect(invoke).not.toHaveBeenCalled();
        expect(process.listenerCount(signal)).toBe(listeners);
        expect(store.getFeatureRun(feature)?.owner).toBeNull();
      } finally {
        store.close();
      }
    },
  );
});

describe.skipIf(process.platform !== 'win32')(
  'feature run with fake CLIs and real WorkStore/Git/verifiers',
  () => {
    it('retains a failed Developer command push before review even if push is later disabled', async () => {
      await spec();
      await runFeatureCommand(['design', feature], repo, () => {}, options('single'));
      const file = path.join(root, '.pixel-agents/config.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      config.projects.test.developer = { pushBranch: { enabled: true, remote: 'broken' } };
      fs.writeFileSync(file, JSON.stringify(config));
      git('remote', 'add', 'broken', path.join(root, 'missing.git'));
      const result = await run('single');
      expect(result.status, result.message).toBe('failed');
      expect(result.message).toContain('branch push failed');
      const store = await storeFor();
      try {
        expect(store.getFeatureRun(feature)?.state.publication).toMatchObject({
          task: 'FEAT-001-T01',
          push: { enabled: true, remote: 'broken' },
        });
        delete config.projects.test.developer;
        fs.writeFileSync(file, JSON.stringify(config));
        const resumed = await run('single');
        expect(resumed.status, resumed.message).toBe('WAITING_HUMAN');
        expect(resumed.message).toContain('publication unresolved');
        expect(store.getTask('FEAT-001-T01')?.status).toBe('REVIEW');
        expect(rows().filter((row) => row.role === 'developer')).toHaveLength(1);
        expect(rows().some((row) => row.role === 'reviewer')).toBe(false);
      } finally {
        store.close();
      }
    });
    it('blocks a pre-existing consumer branch missing its DONE dependency before launch', async () => {
      await spec();
      await runFeatureCommand(['design', feature], repo, () => {}, options());
      const base = git('rev-parse', 'main');
      git('branch', 'sa/FEAT-001-T02-developer', base);
      const result = await run();
      expect(result.status, result.message).toBe('WAITING_HUMAN');
      expect(result.message).toContain('Dependency FEAT-001-T01 is absent');
      expect(rows().some((row) => row.role === 'developer' && row.task === 'FEAT-001-T02')).toBe(
        false,
      );
      const store = await storeFor();
      try {
        expect(store.getTask('FEAT-001-T01')?.status).toBe('DONE');
        expect(() => assertTaskDependencies(store, repo, 'FEAT-001-T02', base)).toThrow(
          'Dependency',
        );
        expect(() =>
          assertTaskDependencies(store, repo, 'FEAT-001-T02', result.integration_sha),
        ).not.toThrow();
      } finally {
        store.close();
      }
    });
    it.each(['failure', 'uncertain', 'interrupted'])(
      'stops and persists optional push %s before review, including on resume',
      async (mode) => {
        await spec();
        await runFeatureCommand(['design', feature], repo, () => {}, options('single'));
        await runFeatureCommand(['develop', feature], repo, () => {}, options('single'));
        const file = path.join(root, '.pixel-agents/config.json');
        const config = JSON.parse(fs.readFileSync(file, 'utf8'));
        config.projects.test.developer = { pushBranch: { enabled: true, remote: 'broken' } };
        fs.writeFileSync(file, JSON.stringify(config));
        git('remote', 'add', 'broken', path.join(root, 'missing.git'));
        const store = await storeFor();
        try {
          const review = store.getTask('FEAT-001-T01')!.review_ref!;
          if (mode === 'interrupted') {
            // The worker persisted its review_ref, but the runner died before
            // recording completion. A later config change must not erase push.
            const main = git('rev-parse', 'main');
            await store.claimFeatureRun(feature, 'interrupted', {
              branch: 'sa/FEAT-001-integration',
              initial_main: main,
              head: main,
              request: 'request.md',
              integrated: {},
              attempts: {},
              status: 'running',
              active: {
                action: 'develop',
                task: 'FEAT-001-T01',
                version: 0,
                publication: { push: { enabled: true, remote: 'broken' } },
              },
            });
            await store.releaseFeatureRun(feature, 'interrupted');
            delete config.projects.test.developer;
            fs.writeFileSync(file, JSON.stringify(config));
          }
          if (mode === 'uncertain')
            await expect(
              store.withIdempotency(`developer-push/FEAT-001-T01/${review.sha}/broken`, () => {
                throw new Error('fixture crash');
              }),
            ).rejects.toThrow('fixture crash');
          for (let attempt = 0; attempt < 2; attempt++) {
            const result = await run('single');
            expect(result.status, result.message).toBe('WAITING_HUMAN');
            expect(result.message).toContain('publication unresolved');
            expect(store.getFeatureRun(feature)?.state.publication).toMatchObject({
              task: 'FEAT-001-T01',
              review,
            });
            expect(store.getTask('FEAT-001-T01')?.status).toBe('REVIEW');
          }
          expect(rows().filter((row) => row.role === 'developer')).toHaveLength(1);
          expect(rows().some((row) => row.role === 'reviewer')).toBe(false);
        } finally {
          store.close();
        }
      },
    );
    it.each(['doc', 'doc-delete'])(
      'integrates %s after cross review without QA or fabricated TestReport',
      async (scenario) => {
        if (scenario === 'doc-delete') {
          fs.mkdirSync(path.join(repo, 'docs'));
          fs.writeFileSync(path.join(repo, 'docs/guide.md'), '# Obsolete guide\n');
          git('add', 'docs/guide.md');
          git('commit', '-m', 'obsolete documentation fixture');
        }
        await spec();
        const main = git('rev-parse', 'main');
        const result = await run(scenario);
        expect(result.status, result.message).toBe('ready_to_merge');
        const store = await storeFor();
        try {
          const key = 'FEAT-001-T03';
          const doc = store.getTask(key)!;
          expect(doc.status).toBe('DONE');
          expect(doc.test_reports ?? []).toEqual([]);
          expect(
            new AuditLog()
              .read('test')
              .some(
                (row) =>
                  !row.corrupt &&
                  row.entry.taskKey === key &&
                  row.entry.outcome.status === 'qa_not_applicable' &&
                  row.entry.outcome.detail === 'QA no aplicable: tarea doc',
              ),
          ).toBe(true);
          expect(doc.review_reports?.at(-1)?.report.verdict).toBe('approve');
          expect(
            store
              .listDomainEvents(key)
              .some((e) => e.to_status === 'DONE' && e.reason === 'QA no aplicable: tarea doc'),
          ).toBe(true);
          expect(
            rows()
              .filter((r) => r.task === key)
              .map((r) => r.role),
          ).toEqual(['developer', 'reviewer']);
          if (scenario === 'doc-delete')
            expect(
              git('ls-tree', '--name-only', result.integration_sha!, '--', 'docs/guide.md'),
            ).toBe('');
          else expect(git('show', `${result.integration_sha}:docs/guide.md`)).toContain('# Guide');
          expect(git('diff-tree', '--no-commit-id', '--name-only', '-r', doc.review_ref!.sha)).toBe(
            'docs/guide.md',
          );
          expect(git('rev-parse', 'main')).toBe(main);
        } finally {
          store.close();
        }
        const count = rows().length;
        expect((await run(scenario)).status).toBe('ready_to_merge');
        expect(rows()).toHaveLength(count);
      },
    );
    it('completes three dependent tasks including qa-author, preserves main and resumes without duplicate effects', async () => {
      const main = git('rev-parse', 'main');
      const result = await run();
      expect(result).toMatchObject({
        status: 'ready_to_merge',
        exit_code: 0,
        integration_branch: 'sa/FEAT-001-integration',
      });
      expect(result.tasks).toHaveLength(3);
      expect(result.tasks.every((t) => t.status === 'DONE' && t.integrated)).toBe(true);
      expect(git('rev-parse', 'main')).toBe(main);
      expect(git('show', `${result.integration_sha}:server/src/step1.ts`)).toContain('step1');
      expect(git('show', `${result.integration_sha}:server/src/step2.ts`)).toContain('step2');
      expect(git('show', `${result.integration_sha}:server/__tests__/step3.test.ts`)).toContain(
        'step2',
      );
      const store = await storeFor();
      try {
        expect(store.getFeature(feature)?.status).toBe('ready_to_merge');
        const tasks = result.tasks.map((t) => store.getTask(t.key)!);
        expect(tasks[1].review_ref!.base).toBe(tasks[0].review_ref!.sha);
        expect(tasks[2].review_ref!.base).toBe(tasks[1].review_ref!.sha);
      } finally {
        store.close();
      }
      expect(
        rows()
          .filter((r) => ['developer', 'reviewer', 'qa'].includes(r.role))
          .map((r) => r.task),
      ).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3].map((n) => `FEAT-001-T0${n}`));
      const before = rows().length;
      // Simulate a crash after Git published T03 but before the SQLite checkpoint committed.
      const replay = await storeFor();
      try {
        const state = replay.getFeatureRun(feature)!.state;
        const previous = replay.getTask('FEAT-001-T02')!.review_ref!.sha;
        state.head = previous;
        state.pending = { task: 'FEAT-001-T03', before: previous, after: result.integration_sha };
        state.status = 'running';
        delete state.integrated['FEAT-001-T03'];
        await replay.claimFeatureRun(feature, 'crash-fixture', state);
        await replay.saveFeatureRun(feature, 'crash-fixture', state);
        await replay.releaseFeatureRun(feature, 'crash-fixture');
      } finally {
        replay.close();
      }
      expect((await run()).integration_sha).toBe(result.integration_sha);
      expect(rows()).toHaveLength(before);
      // Even an already completed run must incorporate main advances before
      // returning ready_to_merge again, without rerunning any executor.
      fs.writeFileSync(path.join(repo, 'later-main.txt'), 'Later main update\n');
      git('add', 'later-main.txt');
      git('commit', '-m', 'later main fixture');
      const advanced = git('rev-parse', 'main');
      const resumed = await run();
      expect(resumed.status, resumed.message).toBe('ready_to_merge');
      expect(git('merge-base', advanced, resumed.integration_sha)).toBe(advanced);
      expect(git('rev-parse', 'main')).toBe(advanced);
      expect(rows()).toHaveLength(before);
    });
    it('creates the spec, stops at human approval, and continues only after explicit approval', async () => {
      expect(await run('valid', ['--request', 'request.md'])).toMatchObject({
        status: 'WAITING_HUMAN',
        exit_code: 3,
      });
      expect(rows().map((r) => r.role)).toEqual(['requirements']);
      expect((await run()).status).toBe('WAITING_HUMAN');
      await runFeatureCommand(['approve', feature], repo, () => {});
      await runFeatureCommand(['design', feature], repo, () => {}, options('single'));
      const store = await storeFor();
      try {
        const input = reviewerDecision('FEAT-001-T01', 'fixture');
        await store.openOrJoinIdleDecision(input);
        expect((await run()).status).toBe('WAITING_HUMAN');
        expect(store.listDecisions()[0].status).toBe('open');
        expect(rows().some((r) => r.role === 'developer')).toBe(false);
        await store.resolveDecision(input.id, 'inspect', 'operator', () => {});
      } finally {
        store.close();
      }
      expect((await run()).status).toBe('ready_to_merge');
    });
    it('performs bounded request_changes rework and finishes', async () => {
      await spec();
      expect((await run('rework')).status).toBe('ready_to_merge');
      expect(
        rows().filter((r) => r.role === 'developer' && r.task === 'FEAT-001-T01'),
      ).toHaveLength(2);
      const store = await storeFor();
      try {
        expect(store.getTask('FEAT-001-T01')!.review_reports!.map((r) => r.report.verdict)).toEqual(
          ['request_changes', 'approve'],
        );
      } finally {
        store.close();
      }
    });
    it('rebases a QA task onto the integration base and preserves an equivalent approval', async () => {
      const checkpoint = await storeFor();
      try {
        await runFeature(
          checkpoint,
          loadProjectConfig(repo, true)!,
          feature,
          'request.md',
          async () => {},
          () => {},
        );
      } finally {
        checkpoint.close();
      }
      await spec();
      await runFeatureCommand(['design', feature], repo, () => {}, options('single'));
      await runFeatureCommand(['develop', feature], repo, () => {}, options('single'));
      await runFeatureCommand(['review', feature], repo, () => {}, options('single'));
      fs.writeFileSync(path.join(repo, 'base-update.txt'), 'An independent base update\n');
      git('add', 'base-update.txt');
      git('commit', '-m', 'fixture base update');
      const main = git('rev-parse', 'main');
      const result = await run('single');
      expect(result.status, result.message).toBe('ready_to_merge');
      expect(rows().filter((r) => r.role === 'reviewer')).toHaveLength(1);
      expect(git('rev-parse', 'main')).toBe(main);
      const store = await storeFor();
      try {
        expect(store.getTask('FEAT-001-T01')!.review_ref!.base).toBe(main);
        expect(
          store.listDomainEvents('FEAT-001-T01').some((e) => e.reason.startsWith('Task rebase ')),
        ).toBe(true);
        const event = store
          .listDomainEvents('FEAT-001-T01')
          .find((e) => e.reason.startsWith('Task rebase '))!;
        const journal = taskBranchBaseFile(repo, 'sa/FEAT-001-T01-developer') + '.rebase';
        fs.writeFileSync(journal, event.reason.slice('Task rebase '.length));
        const before = store.getTask('FEAT-001-T01')!.review_ref;
        await recoverFeatureTaskRebase(store, loadProjectConfig(repo, true)!, 'FEAT-001-T01');
        expect(fs.existsSync(journal)).toBe(false);
        expect(store.getTask('FEAT-001-T01')!.review_ref).toEqual(before);
      } finally {
        store.close();
      }
    });
    it('gates a task rebase conflict after a clean reconciliation of main', async () => {
      await spec();
      await runFeatureCommand(['design', feature], repo, () => {}, options('single'));
      await runFeatureCommand(['develop', feature], repo, () => {}, options('single'));
      await runFeatureCommand(['review', feature], repo, () => {}, options('single'));
      const store = await storeFor();
      try {
        const main = git('rev-parse', 'main');
        const review = store.getTask('FEAT-001-T01')!.review_ref!;
        await store.claimFeatureRun(feature, 'checkpoint', {
          branch: 'sa/FEAT-001-integration',
          initial_main: main,
          head: main,
          request: 'request.md',
          integrated: {},
          attempts: {},
          status: 'running',
        });
        await store.releaseFeatureRun(feature, 'checkpoint');
        fs.writeFileSync(path.join(repo, 'server/src/step1.ts'), 'export const step1 = 100;\n');
        git('add', 'server/src/step1.ts');
        git('commit', '-m', 'conflicting main fixture');
        const advanced = git('rev-parse', 'main');
        const result = await run('single');
        expect(result.status, result.message).toBe('WAITING_HUMAN');
        expect(result.message).toContain('rebase blocked');
        expect(result.message).toContain('Rebase conflict');
        expect(store.getTask('FEAT-001-T01')).toMatchObject({ status: 'QA', review_ref: review });
        expect(git('rev-parse', review.branch)).toBe(review.sha);
        expect(git('rev-parse', 'main')).toBe(advanced);
        expect(store.getFeatureRun(feature)?.state.head).toBe(advanced);
        expect(rows().some((row) => row.role === 'qa')).toBe(false);
      } finally {
        store.close();
      }
    });
    it.each(['retry', 'always-fail'])(
      'bounds retryable failures and forwards persisted context (%s)',
      async (scenario) => {
        await spec();
        const result = await run(scenario);
        expect(result.status, result.message).toBe(
          scenario === 'retry' ? 'ready_to_merge' : 'WAITING_HUMAN',
        );
        const attempts = rows().filter((r) => r.role === 'developer');
        // SA-QA-54: launch 2 is the single free guard correction; always-fail then pays
        // one more attempt (with previousFailure, no second correction) before the gate.
        expect(attempts).toHaveLength(scenario === 'retry' ? 2 : 3);
        expect(JSON.stringify(attempts[1].data)).toMatch(/guardCorrection|previousFailure/);
        const before = rows().length;
        if (scenario === 'always-fail') {
          expect(result.exit_code).toBe(3);
          expect(result.message).toContain('missing_test');
          expect(result.message).toContain('repeated_guard');
          const store = await storeFor();
          try {
            expect(store.getTask('FEAT-001-T01')).toMatchObject({
              status: 'WAITING_HUMAN',
              attempt: 0,
            });
          } finally {
            store.close();
          }
          expect((await run(scenario)).status).toBe('WAITING_HUMAN');
          expect(rows()).toHaveLength(before);
        }
      },
    );
    it('stops on quota, does not exhaust retries while waiting, and reevaluates on the next run', async () => {
      const file = path.join(root, '.pixel-agents/config.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      config.projects.test.concurrency.perExecutor.claude = 0;
      fs.writeFileSync(file, JSON.stringify(config));
      for (let n = 0; n < 4; n++)
        expect(await run('single', n ? [] : ['--request', 'request.md'])).toMatchObject({
          status: 'WAITING_QUOTA',
          exit_code: 3,
        });
      expect(fs.existsSync(launches)).toBe(false);
      config.projects.test.concurrency.perExecutor.claude = 1;
      fs.writeFileSync(file, JSON.stringify(config));
      expect((await run('single')).status).toBe('WAITING_HUMAN');
      expect(rows().map((r) => r.role)).toEqual(['requirements']);
    });
    it('recovers a partially written Architect artifact without rerunning Architect or duplicating ADRs', async () => {
      await spec();
      vi.spyOn(architect, 'writeArchitectArtifacts').mockImplementationOnce((tree, files) => {
        const [relative, content] = [...files][0];
        fs.mkdirSync(path.dirname(path.join(tree, relative)), { recursive: true });
        fs.writeFileSync(
          path.join(tree, relative),
          content.slice(0, Math.floor(content.length / 2)),
        );
        throw new Error('injected interruption during runtime artifact write');
      });
      const result = await run('single');
      expect(result.status, result.message).toBe('ready_to_merge');
      expect(rows().filter((r) => r.role === 'architect')).toHaveLength(1);
      expect(
        fs.readdirSync(path.join(repo, '.worktrees/FEAT-001/.softwareagents/brain/adr')),
      ).toHaveLength(1);
    });
    it('recovers RUNNING before spawn and a dead runner lock, then resumes a commit published before review_ref registration', async () => {
      await spec();
      await runFeatureCommand(['design', feature], repo, () => {}, options('single'));
      const store = await storeFor();
      try {
        const main = git('rev-parse', 'main');
        await store.claimFeatureRun(feature, 'crashed', {
          branch: 'sa/FEAT-001-integration',
          initial_main: main,
          head: main,
          request: 'request.md',
          integrated: {},
          attempts: {},
          status: 'running',
          active: { action: 'develop', task: 'FEAT-001-T01', version: 0, publication: {} },
        });
        const task = await store.claim('FEAT-001-T01', 'dead-worker', 10_000);
        await store.transition(task.key, task.version, 'RUNNING', 'Executor launch', 'dead-worker');
        const deadPid = Number(
          execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
            encoding: 'utf8',
            windowsHide: true,
          }),
        );
        const db = new DatabaseSync(path.join(repo, '.git/softwareagents/work.sqlite3'));
        db.prepare('UPDATE feature_runs SET pid = ?').run(deadPid);
        db.prepare(
          "UPDATE tasks SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE key = 'FEAT-001-T01'",
        ).run();
        db.close();
        // Simulate the commit/ref success followed by a crash before its SQLite review_ref write.
        const prototype = Object.getPrototypeOf(store) as WorkStore;
        vi.spyOn(prototype, 'setTaskReview').mockRejectedValueOnce(
          new Error('injected publication interruption'),
        );
        const result = await run('single');
        expect(result.status, result.message).toBe('ready_to_merge');
        expect(rows().filter((r) => r.role === 'developer')).toHaveLength(1);
        expect(git('rev-list', '--count', `${main}..${result.integration_sha}`)).toBe('1');
        expect(store.getTask(task.key)!.review_reports).toHaveLength(1);
        expect(store.getTask(task.key)!.test_reports).toHaveLength(1);
        expect(store.listWorkerPublications(feature)).toEqual([]);
      } finally {
        store.close();
      }
    });
    it('refuses a second runner under an atomic WorkStore lock and rejects managed ingress and parallel config', async () => {
      const store = await storeFor();
      try {
        const config = loadProjectConfig(repo, true)!;
        await store.claimFeatureRun(feature, 'first', {
          branch: 'sa/FEAT-001-integration',
          initial_main: git('rev-parse', 'main'),
          head: git('rev-parse', 'main'),
          request: 'request.md',
          integrated: {},
          attempts: {},
          status: 'running',
        });
        await expect(run()).rejects.toThrow('another orchestrator');
        await store.releaseFeatureRun(feature, 'first');
        vi.stubEnv('SA_MANAGED_EXECUTION', 'agent');
        await expect(run()).rejects.toThrow('human ingress');
        vi.stubEnv('SA_MANAGED_EXECUTION', undefined);
        config.operator.orchestrator = { maxConcurrentTasks: 2 };
        fs.writeFileSync(
          path.join(root, '.pixel-agents/config.json'),
          JSON.stringify({ projects: { test: config.operator } }),
        );
        await expect(run()).rejects.toThrow('SA-037');
      } finally {
        store.close();
      }
    });
    it('allows managed ingress only for the exact complete SA-003 Operator argv', () => {
      vi.stubEnv('SA_AUTOPILOT', '1');
      const previous = process.argv;
      const argv = [
        process.execPath,
        path.join(repo, 'dist/cli.js'),
        'feature',
        'run',
        feature,
        '--json',
      ];
      const file = path.join(root, '.pixel-agents/config.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      config.companyAutopilot = { [repo]: { command: argv } };
      fs.writeFileSync(file, JSON.stringify(config));
      try {
        process.argv = argv;
        expect(() =>
          assertFeatureRunIngress(loadProjectConfig(repo, true)!, ['run', feature, '--json']),
        ).not.toThrow();
        process.argv = [...argv, '--request', 'request.md'];
        expect(() =>
          assertFeatureRunIngress(loadProjectConfig(repo, true)!, ['run', feature, '--json']),
        ).toThrow('exact Operator');
      } finally {
        process.argv = previous;
      }
    });
    it.skipIf(process.env.SA_SKIP_TASKKILL_TEST === '1')(
      'kills a runner in RUNNING, refuses a simultaneous runner, and resumes via SA-026 without duplicate commits/reports',
      async () => {
        await spec();
        await runFeatureCommand(['design', feature], repo, () => {}, options('single'));
        // The subprocess records real SA-026 identities. Comparing those with
        // the scheduler's synthetic identity would mistake a live PID for reuse.
        const actual = await vi.importActual<typeof import('../src/workstore/processRecovery.js')>(
          '../src/workstore/processRecovery.js',
        );
        vi.spyOn(processRecovery, 'processStartIdentity').mockImplementation(
          actual.processStartIdentity,
        );
        const main = git('rev-parse', 'main');
        const harness = path.resolve(__dirname, '../../dist/feature-run-test.cjs');
        buildSync({
          entryPoints: [path.join(__dirname, 'fixtures/featureRunHarness.ts')],
          outfile: harness,
          bundle: true,
          platform: 'node',
          format: 'cjs',
          target: 'node22',
        });
        const child = spawn(
          process.execPath,
          [harness, repo, path.join(__dirname, 'fixtures/fake-feature-run-cli.cjs'), launches],
          { env: { ...process.env }, windowsHide: true, stdio: 'ignore' },
        );
        try {
          const deadline = Date.now() + 25_000;
          while (!fs.existsSync(launches + '.running') && Date.now() < deadline) {
            if (child.exitCode !== null) throw new Error(`Harness exited ${child.exitCode}`);
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          expect(fs.existsSync(launches + '.running')).toBe(true);
          await expect(run()).rejects.toThrow('another orchestrator');
          const closed = new Promise((resolve) => child.once('close', resolve));
          child.kill();
          await closed;
          const db = new DatabaseSync(path.join(repo, '.git/softwareagents/work.sqlite3'));
          db.prepare(
            "UPDATE tasks SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE key = 'FEAT-001-T01'",
          ).run();
          db.close();
          const result = await run();
          expect(result.status, result.message).toBe('ready_to_merge');
          expect(git('rev-parse', 'main')).toBe(main);
          expect(git('rev-list', '--count', `${main}..${result.integration_sha}`)).toBe('1');
          const store = await storeFor();
          try {
            for (const task of result.tasks) {
              expect(store.getTask(task.key)!.review_reports).toHaveLength(1);
              expect(store.getTask(task.key)!.test_reports).toHaveLength(1);
            }
          } finally {
            store.close();
          }
        } finally {
          fs.writeFileSync(launches + '.stop', 'stop');
          if (child.exitCode === null) child.kill();
          await new Promise((resolve) => setTimeout(resolve, 250));
          const cleanup = await storeFor();
          try {
            const actual = await vi.importActual<
              typeof import('../src/workstore/processRecovery.js')
            >('../src/workstore/processRecovery.js');
            for (const execution of cleanup.listExecutions())
              if (
                execution.pid &&
                execution.pid_started_at &&
                !execution.tree_closed_at &&
                (await actual.processStartIdentity(execution.pid)) === execution.pid_started_at
              )
                process.kill(execution.pid);
          } finally {
            cleanup.close();
          }
        }
      },
    );
  },
);
