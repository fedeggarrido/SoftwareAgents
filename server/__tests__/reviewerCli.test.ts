import { DatabaseSync } from 'node:sqlite';

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { AuditLog } from '../src/auditLog.js';
import { runFeatureCommand } from '../src/commands/feature.js';
import { runTaskCommand } from '../src/commands/task.js';
import { REVIEW_MAX_REWORK_ROUNDS } from '../src/constants.js';
import { EXECUTOR_PROBE_CATALOG } from '../src/executorProbes.js';
import { loadProjectConfig } from '../src/projectConfig.js';
import { lastReviewFailure } from '../src/reviewAttempts.js';
import { type ReviewerRequest, reviewerRequest, validateReview } from '../src/reviewer.js';
import { taskBranchBase, taskBranchBaseFile } from '../src/taskBranchBase.js';
import { hasCurrentApproval, taskRebaseHistory } from '../src/taskRebaseHistory.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import { developerVerifierConfig } from './helpers/developerVerifierConfig.js';
import { readyProbeFor } from './helpers/readyProbe.js';

// Each case runs real Git plus a nested Vitest; under full-suite load on Windows this exceeds 30 s.
vi.setConfig({ testTimeout: 90_000 });
vi.mock('../src/constants.js', async (original) => ({
  ...(await original<typeof import('../src/constants.js')>()),
  CLAUDE_OAUTH_REFRESH_WAIT_MS: 1,
}));
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));
let root: string;
let repo: string;
let launches: string;
const task = 'FEAT-001-T01';
const tree = () => path.join(repo, '.worktrees', task);
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const storeFor = () => openWorkStore({ repositoryPath: repo, projectId: 'test' });
function configure(allowed: string[] = ['claude'], tiers = false) {
  fs.writeFileSync(
    path.join(root, '.pixel-agents/config.json'),
    JSON.stringify({
      projects: {
        test: {
          autonomyLevel: 'A1',
          allowedExecutors: allowed,
          binaryPaths: { claude: process.execPath, codex: process.execPath },
          quotaThresholds: { claude: 0, codex: 0 },
          concurrency: { maxExecutions: 1, perExecutor: { claude: 1, codex: 1 } },
          ...(tiers
            ? {
                modelTiers: {
                  maxTier: 'deep',
                  tiers: {
                    deep: {
                      candidates: [
                        { executor: 'claude', model: 'review-model' },
                        { executor: 'codex', model: 'review-model' },
                      ],
                    },
                  },
                  rule: {
                    ...parse(
                      fs.readFileSync(
                        path.resolve(__dirname, '../../.softwareagents/agents/model-policy.yaml'),
                        'utf8',
                      ),
                    ).tierRule,
                    thresholds: { economy: 0, standard: 1, deep: 2 },
                  },
                },
              }
            : {}),
        },
      },
    }),
  );
}
const run = (command: string[], fixture: string, mode = 'valid', executor = 'claude') =>
  runFeatureCommand(command, repo, () => {}, {
    binaryArgs: [
      path.join(__dirname, `fixtures/fake-${fixture}-cli.cjs`),
      executor,
      mode,
      launches,
    ],
    probe: readyProbeFor(EXECUTOR_PROBE_CATALOG),
  });
const develop = () => run(['develop', 'FEAT-001', '--task', task], 'developer');
const review = (mode = 'approve', executor = 'claude') =>
  run(['review', 'FEAT-001', '--task', task], 'reviewer', mode, executor);
async function prepare() {
  await run(['spec', 'FEAT-001', '--request', 'request.md'], 'requirements');
  await runFeatureCommand(['approve', 'FEAT-001'], repo, () => {});
  await run(['design', 'FEAT-001'], 'architect');
  await develop();
  fs.writeFileSync(launches, '');
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-'));
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
  developerVerifierConfig(repo);
  fs.writeFileSync(
    path.join(repo, '.softwareagents/project.yaml'),
    'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: test\nname: Test\nrepo:\n  remote: https://example.invalid/test.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n',
  );
  fs.writeFileSync(
    path.join(repo, '.softwareagents/agents/model-policy.yaml'),
    'high_reasoning:\n  - executor: claude\n  - executor: codex\nstandard_coding:\n  - executor: claude\n  - executor: codex\nreview:\n  - executor: claude\n  - executor: codex\n',
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

describe('ReviewReport contract', () => {
  const input = {
    files: ['server/src/audit.ts'],
    task: { acceptanceRefs: ['AC-001'] },
  } as ReviewerRequest;
  const finding = {
    severity: 'major',
    file: 'server/src/audit.ts',
    summary: 'Gap',
    suggestion: 'Fix it',
  };
  it('rejects empty/minor-only rejection, foreign paths, invalid lines, unknown ACs and contradictory approval', () => {
    for (const value of [
      { verdict: 'request_changes', findings: [] },
      { verdict: 'request_changes', findings: [{ ...finding, severity: 'minor' }] },
      { verdict: 'request_changes', findings: [{ ...finding, file: '../outside' }] },
      { verdict: 'request_changes', findings: [{ ...finding, line: 0 }] },
      { verdict: 'approve', findings: [], acCoverage: [{ ac: 'AC-999', status: 'covered' }] },
      { verdict: 'approve', findings: [finding] },
    ])
      expect(() => validateReview(JSON.stringify(value), input)).toThrow();
    expect(
      validateReview(JSON.stringify({ verdict: 'request_changes', findings: [finding] }), input)
        .verdict,
    ).toBe('request_changes');
  });
});

describe.skipIf(process.platform !== 'win32')('Reviewer via worker (fake CLIs)', () => {
  describe('human task rebase', () => {
    // Build the approved-task fixture separately; the rebase/rework assertions retain
    // their 90 s budget even on slow Windows hosts with real nested verifiers.
    beforeEach(async (context) => {
      if (
        context.task.name.startsWith('keeps QA and immutable reports') ||
        context.task.name.startsWith('returns a changed patch')
      ) {
        await prepare();
        await review();
      }
    }, 90_000);
    const rebase = () => runFeatureCommand(['rebase', 'FEAT-001', '--task', task], repo, () => {});
    const advance = (file = 'base-fix.txt', contents = 'new Project base\n') => {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), contents);
      git(repo, 'add', file);
      git(repo, 'commit', '-m', 'advance main');
      return git(repo, 'rev-parse', 'main');
    };
    it('keeps QA and immutable reports for identical patches; all subsequent commands accept the base', async () => {
      await run(['qa', 'FEAT-001', '--task', task], 'qa', 'not_tested');
      const store = await storeFor();
      try {
        const before = store.getTask(task)!;
        const base = advance();
        await rebase();
        const after = store.getTask(task)!;
        expect(after.status).toBe('QA');
        expect(after.attempt).toBe(before.attempt);
        expect(after.review_reports).toEqual(before.review_reports);
        expect(after.test_reports).toEqual(before.test_reports);
        expect(after.review_ref).toEqual({
          branch: before.branch,
          base,
          sha: git(tree(), 'rev-parse', 'HEAD'),
        });
        expect(after.review_ref!.sha).not.toBe(before.review_ref!.sha);
        expect(git(repo, 'rev-parse', after.branch!)).toBe(after.review_ref!.sha);
        expect(taskBranchBase(repo, after.branch!, 'main')).toBe(base);
        expect(hasCurrentApproval(store, task)).toBe(true);
        const config = loadProjectConfig(repo, true)!;
        expect(reviewerRequest(store, config, 'FEAT-001', task, undefined, 'qa').reviewRef).toEqual(
          after.review_ref,
        );
        const count = store.listExecutions().length;
        await develop();
        expect(store.listExecutions()).toHaveLength(count);
        const log = vi.fn();
        await runFeatureCommand(['show', 'FEAT-001', '--json'], repo, log);
        expect(
          JSON.parse(log.mock.calls[0][0]).tasks.find((t: { key: string }) => t.key === task)
            .review_ref.base,
        ).toBe(base);
        const history = taskRebaseHistory(store, task);
        expect(history.at(-1)!.oldPatchId).toBe(history.at(-1)!.newPatchId);
        expect(
          new AuditLog()
            .read('test')
            .some(
              (row) =>
                !row.corrupt &&
                row.entry.action === 'feature_rebase' &&
                row.entry.outcome.status === 'persisted' &&
                row.entry.outcome.detail?.includes(after.review_ref!.sha),
            ),
        ).toBe(true);
        // A second equivalent rebase must carry the original approval through the full chain.
        advance('second-fix.txt');
        await rebase();
        expect(hasCurrentApproval(store, task)).toBe(true);
        await run(['qa', 'FEAT-001', '--task', task], 'qa', 'pass');
        expect(store.getTask(task)!.status).toBe('DONE');
      } finally {
        store.close();
      }
    });

    it('returns a changed patch to REVIEW and requires a new approval on the new base', async () => {
      const store = await storeFor();
      try {
        const before = store.getTask(task)!;
        // Main now includes the source change, leaving only the test in the task's patch.
        let base = advance(
          'server/src/audit.ts',
          fs.readFileSync(path.join(tree(), 'server/src/audit.ts'), 'utf8'),
        );
        await rebase();
        const after = store.getTask(task)!;
        expect(after.status).toBe('REVIEW');
        expect(after.review_reports).toEqual(before.review_reports);
        expect(after.review_ref!.base).toBe(base);
        const history = taskRebaseHistory(store, task).at(-1)!;
        expect(history.oldPatchId).not.toBe(history.newPatchId);
        expect(hasCurrentApproval(store, task)).toBe(false);
        await expect(run(['qa', 'FEAT-001', '--task', task], 'qa')).rejects.toThrow('QA requires');
        expect(
          reviewerRequest(store, loadProjectConfig(repo, true)!, 'FEAT-001', task).reviewRef,
        ).toEqual(after.review_ref);
        // A later equivalent rebase must not revive approval invalidated by this one.
        base = advance('later-fix.txt');
        await rebase();
        expect(store.getTask(task)!.status).toBe('REVIEW');
        expect(hasCurrentApproval(store, task)).toBe(false);
        await review('reject');
        await expect(
          run(['develop', 'FEAT-001', '--task', task], 'developer', 'bad-test'),
        ).rejects.toThrow();
        expect(store.getTask(task)!.status).toBe('FAILED_RETRYABLE');
        await develop();
        expect(store.getTask(task)!.review_ref!.base).toBe(base);
        await review();
        expect(hasCurrentApproval(store, task)).toBe(true);
        await run(['qa', 'FEAT-001', '--task', task], 'qa', 'pass');
        expect(store.getTask(task)!.status).toBe('DONE');
      } finally {
        store.close();
      }
    });

    it('aborts conflicts without changing branch, task worktree, registry or WorkStore', async () => {
      await prepare();
      const store = await storeFor();
      try {
        advance('server/src/audit.ts', 'export const implemented = false;\n');
        const before = store.getTask(task)!;
        const registry = taskBranchBaseFile(repo, before.branch!);
        const metadata = fs.readFileSync(registry, 'utf8');
        const worktrees = git(repo, 'worktree', 'list', '--porcelain');
        await expect(rebase()).rejects.toThrow('conflict');
        expect(store.getTask(task)).toEqual(before);
        expect(fs.readFileSync(registry, 'utf8')).toBe(metadata);
        expect(fs.existsSync(registry + '.rebase')).toBe(false);
        expect(git(tree(), 'rev-parse', 'HEAD')).toBe(before.review_ref!.sha);
        expect(git(tree(), 'status', '--porcelain')).toBe('');
        expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(worktrees);
        expect(taskRebaseHistory(store, task)).toEqual([]);
      } finally {
        store.close();
      }
    });

    it('names ignored and untracked residues and rejects a moved HEAD before staging', async () => {
      advance('.gitignore', 'ignored.txt\n');
      await prepare();
      advance();
      const store = await storeFor();
      try {
        const before = store.getTask(task)!;
        for (const file of ['ignored.txt', 'untracked.txt']) {
          fs.writeFileSync(path.join(tree(), file), 'retain this evidence');
          await expect(rebase()).rejects.toThrow(file);
          expect(fs.readFileSync(path.join(tree(), file), 'utf8')).toBe('retain this evidence');
          expect(store.getTask(task)).toEqual(before);
          fs.unlinkSync(path.join(tree(), file));
        }
        const empty = path.join(tree(), 'empty-residue');
        fs.mkdirSync(empty);
        await expect(rebase()).rejects.toThrow('empty-residue');
        fs.rmdirSync(empty);
        const linked = path.join(tree(), 'node_modules');
        const evidence = path.join(root, 'linked-evidence.txt');
        fs.writeFileSync(evidence, 'outside the task worktree');
        fs.symlinkSync(root, linked, 'junction');
        try {
          await expect(rebase()).rejects.toThrow('node_modules');
          expect(fs.readFileSync(evidence, 'utf8')).toBe('outside the task worktree');
          expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
          expect(store.getTask(task)).toEqual(before);
        } finally {
          fs.unlinkSync(linked);
        }
        git(tree(), 'commit', '--allow-empty', '-m', 'moved head');
        await expect(rebase()).rejects.toThrow('SHA/base/branch');
        expect(store.getTask(task)).toEqual(before);
      } finally {
        store.close();
      }
    });

    it('rejects every managed ingress marker, including an empty marker', async () => {
      await prepare();
      const store = await storeFor();
      try {
        const before = store.getTask(task)!;
        for (const marker of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE']) {
          vi.stubEnv(marker, '');
          await expect(rebase()).rejects.toThrow('human operator');
          vi.stubEnv(marker, undefined);
          expect(store.getTask(task)).toEqual(before);
        }
      } finally {
        store.close();
      }
    });

    it('rolls back Git and registry when publication fails inside the SQLite transaction', async () => {
      await prepare();
      advance();
      const store = await storeFor();
      try {
        const before = store.getTask(task)!;
        const registry = taskBranchBaseFile(repo, before.branch!);
        const metadata = fs.readFileSync(registry, 'utf8');
        const db = new DatabaseSync(path.join(repo, '.git/softwareagents/work.sqlite3'));
        try {
          db.exec(`CREATE TRIGGER fail_rebase BEFORE UPDATE OF review_ref ON tasks
            BEGIN SELECT RAISE(ABORT, 'injected SQLite publication failure'); END`);
        } finally {
          db.close();
        }
        await expect(rebase()).rejects.toThrow('injected SQLite publication failure');
        expect(store.getTask(task)).toEqual(before);
        expect(git(tree(), 'rev-parse', 'HEAD')).toBe(before.review_ref!.sha);
        expect(git(tree(), 'status', '--porcelain')).toBe('');
        expect(fs.readFileSync(registry, 'utf8')).toBe(metadata);
        expect(fs.existsSync(registry + '.rebase')).toBe(false);
      } finally {
        store.close();
      }
    });

    it('fails closed on an interrupted publication instead of guessing the base', async () => {
      await prepare();
      const store = await storeFor();
      try {
        const before = store.getTask(task)!;
        const journal = taskBranchBaseFile(repo, before.branch!) + '.rebase';
        fs.writeFileSync(journal, '{}');
        await expect(rebase()).rejects.toThrow('reconciliation');
        expect(() =>
          reviewerRequest(store, loadProjectConfig(repo, true)!, 'FEAT-001', task),
        ).toThrow('reconciliation');
        await expect(develop()).rejects.toThrow('reconciliation');
        expect(store.getTask(task)).toEqual(before);
        expect(fs.existsSync(journal)).toBe(true);
      } finally {
        store.close();
      }
    });

    it('requires audit intent and reports an already persisted rebase if confirmation fails', async () => {
      await prepare();
      const base = advance();
      const store = await storeFor();
      try {
        const before = store.getTask(task)!;
        const registry = taskBranchBaseFile(repo, before.branch!);
        const metadata = fs.readFileSync(registry, 'utf8');
        const worktrees = git(repo, 'worktree', 'list', '--porcelain');
        const append = AuditLog.prototype.append;
        const spy = vi.spyOn(AuditLog.prototype, 'append').mockImplementation(function (
          this: AuditLog,
          entry,
        ) {
          if (entry.action === 'feature_rebase' && entry.outcome.status === 'pending')
            throw new Error('rebase audit intent unavailable');
          return append.call(this, entry);
        });
        await expect(rebase()).rejects.toThrow('rebase audit intent unavailable');
        expect(store.getTask(task)).toEqual(before);
        expect(fs.readFileSync(registry, 'utf8')).toBe(metadata);
        expect(fs.existsSync(registry + '.rebase')).toBe(false);
        expect(git(tree(), 'rev-parse', 'HEAD')).toBe(before.review_ref!.sha);
        expect(git(tree(), 'status', '--porcelain')).toBe('');
        expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(worktrees);
        spy.mockImplementation(function (this: AuditLog, entry) {
          if (entry.action === 'feature_rebase' && entry.outcome.status === 'persisted')
            throw new Error('rebase audit confirmation unavailable');
          return append.call(this, entry);
        });
        await expect(rebase()).rejects.toThrow('Rebase persisted; audit confirmation pending');
        const after = store.getTask(task)!;
        expect(after.review_ref!.base).toBe(base);
        expect(after.review_ref!.sha).not.toBe(before.review_ref!.sha);
        expect(git(tree(), 'rev-parse', 'HEAD')).toBe(after.review_ref!.sha);
        expect(git(repo, 'rev-parse', after.branch!)).toBe(after.review_ref!.sha);
        expect(taskBranchBase(repo, after.branch!, 'main')).toBe(base);
        expect(taskRebaseHistory(store, task)).toHaveLength(1);
        expect(fs.existsSync(registry + '.rebase')).toBe(false);
        expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(
          worktrees.replace(before.review_ref!.sha, after.review_ref!.sha),
        );
      } finally {
        store.close();
      }
    });
  });
  describe('Developer rework', () => {
    beforeEach(prepare, 30_000);
    it('rejects, passes findings into actual Developer rework and then approves into QA', async () => {
      const main = git(repo, 'rev-parse', 'main');
      await review('reject');
      const store = await storeFor();
      try {
        const rejected = store.getTask(task)!;
        expect(rejected.status).toBe('READY');
        expect(rejected.attempt).toBe(1);
        expect(rejected.review_ref).toBeNull();
        expect(rejected.review_reports).toHaveLength(1);
        expect(
          store.listExecutions().find((e) => e.agent_role === 'reviewer')?.selection_reason,
        ).toContain('same_executor_no_available_alternative');
        await develop();
        const launch = fs
          .readFileSync(launches, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
          .at(-1);
        expect(JSON.parse(launch.context.task.brief).reviewFindings).toEqual(
          rejected.review_reports![0].report.findings,
        );
        expect(store.getTask(task)!.review_ref!.sha).not.toBe(
          rejected.review_reports![0].review_ref.sha,
        );
        await review();
        expect(store.getTask(task)!.status).toBe('QA');
        expect(store.getTask(task)!.attempt).toBe(1);
        expect(store.getTask(task)!.review_reports).toHaveLength(2);
        const log = vi.fn();
        await runFeatureCommand(['show', 'FEAT-001', '--json'], repo, log);
        expect(
          JSON.parse(log.mock.calls[0][0]).tasks.find((t: { key: string }) => t.key === task)
            .review_reports,
        ).toHaveLength(2);
        expect(git(repo, 'rev-parse', 'main')).toBe(main);
      } finally {
        store.close();
      }
    });
  });
  it.each(['claude', 'codex'])(
    'selects only a reader after Developer %s and records it in trace/audit',
    async (developer) => {
      if (developer === 'codex') configure(['codex']);
      if (developer === 'codex') {
        await run(
          ['spec', 'FEAT-001', '--request', 'request.md'],
          'requirements',
          'valid',
          'codex',
        );
        await runFeatureCommand(['approve', 'FEAT-001'], repo, () => {});
        await run(['design', 'FEAT-001'], 'architect', 'valid', 'codex');
        await run(['develop', 'FEAT-001', '--task', task], 'developer', 'valid', 'codex');
        fs.writeFileSync(launches, '');
      } else await prepare();
      configure(['claude', 'codex']);
      const other = 'claude';
      const outcome =
        developer === 'codex' ? 'cross_executor' : 'same_executor_no_available_alternative';
      const sha = git(tree(), 'rev-parse', 'HEAD');
      await review('approve', other);
      const store = await storeFor();
      try {
        expect(store.getTask(task)!.review_reports![0]).toMatchObject({
          developer_executor: developer,
          reviewer_executor: other,
        });
        expect(
          store.listExecutions().find((e) => e.agent_role === 'reviewer')?.selection_reason,
        ).toContain(outcome);
        expect(git(tree(), 'rev-parse', 'HEAD')).toBe(sha);
        expect(git(tree(), 'status', '--porcelain')).toBe('');
        const launch = JSON.parse(fs.readFileSync(launches, 'utf8').trim());
        expect(launch.data.diff).toContain('export const implemented');
        expect(launch.data.reviewRef.sha).toBe(sha);
        expect(launch.args[launch.args.indexOf('--tools') + 1]).not.toMatch(/Write|Edit|Bash/);
        const common = path.resolve(repo, git(repo, 'rev-parse', '--git-common-dir'));
        const telemetry = fs.readFileSync(
          path.join(common, 'softwareagents/telemetry/test/spans.jsonl'),
          'utf8',
        );
        expect(telemetry).toContain('softwareagents.review.selection');
        expect(telemetry).toContain(outcome);
        const audit = fs.readFileSync(path.join(root, '.pixel-agents/audit/test.jsonl'), 'utf8');
        expect(audit).toContain('review_executor_selected');
        expect(audit).toContain(outcome);
        expect(audit).toContain('review_report_persisted');
      } finally {
        store.close();
      }
    },
  );
  it.each([false, true])(
    'waits for a reader when only Codex is enabled (tiers=%s)',
    async (tiers) => {
      await prepare();
      configure(['codex'], tiers);
      await review('approve', 'codex');
      const store = await storeFor();
      try {
        expect(store.getTask(task)).toMatchObject({
          status: 'WAITING_HUMAN',
          attempt: 0,
          review_reports: [],
        });
        expect(store.listDecisions()[0].context).toContain('code_execution_not_mediated');
        expect(fs.readFileSync(launches, 'utf8')).toBe('');
        configure(['claude'], tiers);
        await review();
        expect(store.getTask(task)!.status).toBe('QA');
      } finally {
        store.close();
      }
    },
  );
  it('retries an invalid report once with errors and a new Execution', async () => {
    await prepare();
    await review('repair');
    const logs = fs
      .readFileSync(launches, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(logs).toHaveLength(2);
    expect(logs[0].data.validationErrors).toEqual([]);
    expect(logs[1].data.validationErrors.length).toBeGreaterThan(0);
    const store = await storeFor();
    try {
      expect(store.getTask(task)!.status).toBe('QA');
      expect(store.getTask(task)!.review_reports).toHaveLength(1);
    } finally {
      store.close();
    }
  });
  it('excludes shell-capable Codex from the Operator tier catalog without running implementation verifiers', async () => {
    await prepare();
    configure(['claude', 'codex'], true);
    await review('approve', 'claude');
    const store = await storeFor();
    try {
      const execution = store.listExecutions().find((e) => e.agent_role === 'reviewer')!;
      expect(execution.executor).toBe('claude');
      expect(execution.model_tier).toBe('deep');
      expect(execution.selection_reason).toContain('code_execution_not_mediated');
      expect(store.getTask(task)!.status).toBe('QA');
    } finally {
      store.close();
    }
  });
  it('falls back to the Developer executor when the alternative requires authentication', async () => {
    await prepare();
    configure(['claude', 'codex']);
    const ready = readyProbeFor(EXECUTOR_PROBE_CATALOG);
    await runFeatureCommand(['review', 'FEAT-001'], repo, () => {}, {
      binaryArgs: [
        path.join(__dirname, 'fixtures/fake-reviewer-cli.cjs'),
        'claude',
        'approve',
        launches,
      ],
      probe: (file, args) =>
        args[0] === 'login' && args[1] === 'status'
          ? Promise.resolve({ code: 1, output: 'Not logged in' })
          : ready(file, args),
    });
    const store = await storeFor();
    try {
      expect(store.getTask(task)!.review_reports![0].reviewer_executor).toBe('claude');
      expect(
        store.listExecutions().find((e) => e.agent_role === 'reviewer')?.selection_reason,
      ).toContain('same_executor_no_available_alternative');
    } finally {
      store.close();
    }
  });
  it.each(['before', 'during'])('rejects a changed SHA %s reviewing', async (when) => {
    await prepare();
    if (when === 'before')
      git(tree(), '-c', 'core.hooksPath=', 'commit', '--allow-empty', '-m', 'moved');
    await expect(review(when === 'during' ? 'changed-sha' : 'approve')).rejects.toThrow(/SHA|HEAD/);
    const store = await storeFor();
    try {
      expect(store.getTask(task)!.review_reports).toHaveLength(0);
    } finally {
      store.close();
    }
  });
  it('fails closed on an attempted write without registering any report', async () => {
    await prepare();
    await expect(review('outside')).rejects.toThrow(/containment/);
    const store = await storeFor();
    try {
      expect(store.getTask(task)!.review_reports).toHaveLength(0);
    } finally {
      store.close();
    }
  });
  describe('invalid report recovery', () => {
    beforeEach(prepare, 30_000);
    it('retains REVIEW after two invalid reports and allows another review', async () => {
      await review('invalid');
      const store = await storeFor();
      try {
        expect(store.getTask(task)!).toMatchObject({
          status: 'REVIEW',
          attempt: 0,
          review_reports: [],
        });
        expect(store.listDecisions()).toHaveLength(0);
        expect(store.listDomainEvents(task).at(-1)?.reason).toContain('category=invalid_report');
        await review();
        expect(store.getTask(task)!.status).toBe('QA');
      } finally {
        store.close();
      }
      expect(fs.readFileSync(launches, 'utf8').trim().split('\n')).toHaveLength(3);
    });
  });
  it.each(['oauth', 'auth', 'spawn', 'timeout', 'quota'])(
    'preserves the Developer result after Reviewer infrastructure failure: %s',
    async (cause) => {
      await prepare();
      const store = await storeFor();
      try {
        const before = store.getTask(task)!;
        if (cause === 'quota') await review(`fail-${cause}`);
        else await expect(review(`fail-${cause}`)).rejects.toThrow();
        expect(store.getTask(task)!).toMatchObject({
          status: 'REVIEW',
          attempt: before.attempt,
          review_ref: before.review_ref,
          review_reports: [],
          lease_owner: null,
        });
        expect(store.listDecisions()).toHaveLength(0);
        const category = cause === 'oauth' ? 'oauth_refresh_contention' : cause;
        const log = vi.fn();
        await runFeatureCommand(['show', 'FEAT-001', '--json'], repo, log);
        const failed = JSON.parse(log.mock.calls[0][0]).tasks.find(
          (t: { key: string }) => t.key === task,
        ).last_review_failure;
        expect(failed.reason).toContain(`category=${category}`);
        log.mockClear();
        await runTaskCommand(['list', '--json'], repo, log);
        expect(
          JSON.parse(log.mock.calls[0][0]).find((t: { key: string }) => t.key === task)
            .last_review_failure,
        ).toEqual(failed);
        for (const command of [['list'], ['show', 'FEAT-001']]) {
          log.mockClear();
          if (command[0] === 'list') await runTaskCommand(command, repo, log);
          else await runFeatureCommand(command, repo, log);
          expect(log.mock.calls[0][0]).toContain(`category=${category}`);
        }
        const audit = fs.readFileSync(path.join(root, '.pixel-agents/audit/test.jsonl'), 'utf8');
        expect(audit).toContain(`category=${category}`);
        expect(audit).not.toContain('SECRET_OUTPUT');
        await review();
        expect(store.getTask(task)!).toMatchObject({ status: 'QA', attempt: before.attempt });
        expect(lastReviewFailure(store, store.getTask(task)!)).toBeNull();
      } finally {
        store.close();
      }
    },
    // oauth retries launch the fake CLI three times (~10 s each on Windows).
    60_000,
  );
  it('resumes a legacy FAILED_RETRYABLE Reviewer by implicit feature review', async () => {
    await prepare();
    await expect(review('fail-auth')).rejects.toThrow();
    const db = new DatabaseSync(path.join(repo, '.git/softwareagents/work.sqlite3'));
    db.prepare("UPDATE tasks SET status = 'FAILED_RETRYABLE', attempt = 2 WHERE key = ?").run(task);
    db.close();
    await run(['review', 'FEAT-001'], 'reviewer', 'approve');
    const store = await storeFor();
    try {
      expect(store.getTask(task)!).toMatchObject({ status: 'QA', attempt: 2 });
      expect(store.listDomainEvents(task)).toContainEqual(
        expect.objectContaining({ from_status: 'FAILED_RETRYABLE', to_status: 'REVIEW' }),
      );
    } finally {
      store.close();
    }
  });
  it('leaves REVIEW without opening a Human Decision when auth probes block Reviewer', async () => {
    await prepare();
    const ready = readyProbeFor(EXECUTOR_PROBE_CATALOG);
    await runFeatureCommand(['review', 'FEAT-001'], repo, () => {}, {
      probe: (file, args) =>
        args[0] === 'auth'
          ? Promise.resolve({ code: 1, output: '{"loggedIn":false}' })
          : ready(file, args),
    });
    const store = await storeFor();
    try {
      expect(store.getTask(task)!).toMatchObject({
        status: 'REVIEW',
        attempt: 0,
        review_reports: [],
      });
      expect(store.getTask(task)!.review_ref).toBeTruthy();
      expect(store.listDecisions()).toEqual([]);
      expect(store.listDomainEvents(task).at(-1)?.reason).toContain('auth_required');
      expect(fs.readFileSync(launches, 'utf8')).toBe('');
      await review();
      expect(store.getTask(task)!.status).toBe('QA');
    } finally {
      store.close();
    }
  });
  it('passes the optional Claude profile to the supervised spawn and all worker probes', async () => {
    await prepare();
    const configDir = path.join(root, 'worker-profile');
    fs.mkdirSync(configDir);
    const file = path.join(root, '.pixel-agents/config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.projects.test.executors = { claude: { configDir } };
    fs.writeFileSync(file, JSON.stringify(config));
    const probe = vi.fn(readyProbeFor(EXECUTOR_PROBE_CATALOG));
    await runFeatureCommand(['review', 'FEAT-001'], repo, () => {}, {
      binaryArgs: [
        path.join(__dirname, 'fixtures/fake-reviewer-cli.cjs'),
        'claude',
        'approve',
        launches,
      ],
      probe,
    });
    expect(JSON.parse(fs.readFileSync(launches, 'utf8').trim()).configDir).toBe(
      fs.realpathSync.native(configDir),
    );
    expect(probe.mock.calls.length).toBeGreaterThan(0);
    for (const call of probe.mock.calls)
      expect(call[2]).toEqual({ CLAUDE_CONFIG_DIR: fs.realpathSync.native(configDir) });
    expect(probe.mock.calls.some((call) => call[1].join(' ') === 'auth status --json')).toBe(true);
  });
  it('persists the last report and opens an atomic HumanDecision beyond the rework round limit', async () => {
    await prepare();
    // Seed completed historical rounds; exercise the boundary with a real fake-CLI execution.
    const db = new DatabaseSync(path.join(repo, '.git/softwareagents/work.sqlite3'));
    const previous = Array.from({ length: REVIEW_MAX_REWORK_ROUNDS }, (_, round) => ({
      execution_id: `history-${round}`,
      review_ref: { branch: `sa/${task}-developer`, sha: 'a'.repeat(40), base: 'b'.repeat(40) },
      developer_executor: 'claude',
      reviewer_executor: 'codex',
      report: {
        verdict: 'request_changes',
        findings: [
          { severity: 'major', file: 'server/src/audit.ts', summary: 'Gap', suggestion: 'Fix it' },
        ],
      },
    }));
    db.prepare('UPDATE tasks SET attempt = ?, review_reports = ? WHERE key = ?').run(
      REVIEW_MAX_REWORK_ROUNDS,
      JSON.stringify(previous),
      task,
    );
    db.close();
    await review('reject');
    const store = await storeFor();
    try {
      expect(store.getTask(task)!.status).toBe('WAITING_HUMAN');
      expect(store.getTask(task)!.attempt).toBe(REVIEW_MAX_REWORK_ROUNDS);
      expect(store.getTask(task)!.review_reports).toHaveLength(REVIEW_MAX_REWORK_ROUNDS + 1);
      expect(store.listDecisions()[0].context).toContain('rework_limit');
    } finally {
      store.close();
    }
  });
});
