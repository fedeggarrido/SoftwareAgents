import { DatabaseSync } from 'node:sqlite';

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { runFeatureCommand } from '../src/commands/feature.js';
import { REVIEW_MAX_REWORK_ROUNDS } from '../src/constants.js';
import * as verifier from '../src/evalCriteria.js';
import { EXECUTOR_PROBE_CATALOG } from '../src/executorProbes.js';
import { validateTestReport } from '../src/qa.js';
import { lastReviewFailure } from '../src/reviewAttempts.js';
import type { ReviewerRequest } from '../src/reviewer.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
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
  await review();
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

const qa = (mode = 'pass', executor = 'claude') =>
  run(['qa', 'FEAT-001', '--task', task], 'qa', mode, executor);

describe('TestReport contract', () => {
  const input = { task: { acceptanceRefs: ['AC-001'] } } as ReviewerRequest;
  const commands = [
    {
      command: 'vitest:server/__tests__/audit.test.ts',
      result: 'pass' as const,
      passed: 1,
      failed: 0,
    },
  ];
  const report = {
    verdict: 'pass',
    acceptance: [
      { ac: 'AC-001', status: 'pass', evidence: 'Runtime assertion and source inspected' },
    ],
    commands,
    defects: [],
  };
  it('requires exact AC coverage, runtime evidence, linked failures and consistent verdicts', () => {
    expect(validateTestReport(JSON.stringify(report), input, commands)).toEqual(report);
    for (const value of [
      { ...report, acceptance: [] },
      { ...report, acceptance: [...report.acceptance, ...report.acceptance] },
      { ...report, acceptance: [{ ac: 'AC-999', status: 'pass', evidence: 'x' }] },
      { ...report, commands: [{ command: 'node evil.js', result: 'pass', passed: 1, failed: 0 }] },
      {
        ...report,
        verdict: 'fail',
        acceptance: [{ ac: 'AC-001', status: 'fail', evidence: 'broken' }],
      },
      {
        ...report,
        verdict: 'pass',
        acceptance: [{ ac: 'AC-001', status: 'not_tested', evidence: 'unknown' }],
      },
      {
        ...report,
        defects: [{ ac: 'AC-999', severity: 'major', summary: 'x', reproduction: 'x' }],
      },
      { ...report, commandRequests: ['npm install'] },
    ])
      expect(() => validateTestReport(JSON.stringify(value), input, commands)).toThrow();
    expect(() =>
      validateTestReport(JSON.stringify(report), input, [
        { ...commands[0], result: 'fail', failed: 1 },
      ]),
    ).toThrow();
  });
});

describe.skipIf(process.platform !== 'win32')('QA via worker (fake CLIs)', () => {
  beforeEach(prepare, 30_000);
  it.each([false, true])(
    'passes via a safe reader (Codex enabled=%s), persists report, keeps approved SHA and promotes T02',
    async (codexEnabled) => {
      const executor = 'claude';
      configure(codexEnabled ? ['claude', 'codex'] : ['claude']);
      const store = await storeFor();
      try {
        const before = store.getTask(task)!;
        await qa('pass', executor);
        const done = store.getTask(task)!;
        expect(done).toMatchObject({
          status: 'DONE',
          attempt: before.attempt,
          review_ref: before.review_ref,
        });
        expect(done.test_reports).toHaveLength(1);
        const record = done.test_reports![0];
        expect(JSON.parse(fs.readFileSync(record.artifact_path, 'utf8'))).toEqual(record);
        expect(record.report.commands).toEqual([
          {
            command: 'vitest:server/__tests__/audit.test.ts',
            result: 'pass',
            passed: 1,
            failed: 0,
          },
        ]);
        expect(store.getTask('FEAT-001-T02')!.status).toBe('READY');
        expect(store.canStart('FEAT-001-T02')).toBe(true);
        expect(git(tree(), 'rev-parse', 'HEAD')).toBe(before.review_ref!.sha);
        expect(git(tree(), 'status', '--porcelain')).toBe('');
        const launch = JSON.parse(fs.readFileSync(launches, 'utf8').trim());
        expect(launch.data.commandAllowlist).toEqual(record.report.commands.map((c) => c.command));
        expect(launch.data.commands).toEqual(record.report.commands);
        expect(launch.args[launch.args.indexOf('--tools') + 1]).not.toMatch(/Write|Edit|Bash/);
        expect(store.listExecutions().find((e) => e.agent_role === 'qa')!.executor).toBe('claude');
        const log = vi.fn();
        await runFeatureCommand(['show', 'FEAT-001', '--json'], repo, log);
        expect(
          JSON.parse(log.mock.calls[0][0]).tasks.find((t: { key: string }) => t.key === task)
            .test_reports,
        ).toEqual(done.test_reports);
      } finally {
        store.close();
      }
    },
  );
  it.each([false, true])('never launches shell-capable Codex for QA (tiers=%s)', async (tiers) => {
    configure(['codex'], tiers);
    await qa('command-execution', 'codex');
    const store = await storeFor();
    try {
      expect(store.getTask(task)).toMatchObject({
        status: 'WAITING_HUMAN',
        attempt: 0,
        test_reports: [],
      });
      expect(store.getTask(task)!.review_ref).toBeTruthy();
      expect(store.listExecutions().filter((e) => e.agent_role === 'qa')).toEqual([]);
      expect(store.listDecisions()[0].context).toContain('code_execution_not_mediated');
      expect(fs.readFileSync(launches, 'utf8')).toBe('');
      // Repeated selection joins the existing decision, then a safe executor restores QA.
      await qa('command-execution', 'codex');
      expect(store.listDecisions()).toHaveLength(1);
      configure(['claude'], tiers);
      await qa();
      expect(store.getTask(task)!.status).toBe('DONE');
      expect(store.listDecisions()[0].status).toBe('answered');
      expect(store.listExecutions().find((e) => e.agent_role === 'qa')!.selection_reason).toContain(
        'code_execution_not_mediated',
      );
    } finally {
      store.close();
    }
  });
  it('creates traceable defects, shares rounds and supplies them to Developer rework', async () => {
    await qa('fail');
    const store = await storeFor();
    try {
      const rejected = store.getTask(task)!;
      expect(rejected).toMatchObject({ status: 'READY', attempt: 1, review_ref: null });
      const defect = store.getTask(task + '-D1')!;
      expect(defect.type).toBe('bug');
      expect(defect.defect_context).toMatchObject({
        task,
        ac: 'AC-001',
        review_ref: rejected.test_reports![0].review_ref,
        summary: 'Missing edge case',
      });
      expect(store.getTask('FEAT-001-T02')!.status).toBe('DRAFT');
      await develop();
      const logs = fs
        .readFileSync(launches, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(JSON.parse(logs.at(-1).context.task.brief).qaDefects).toContainEqual(
        defect.defect_context,
      );
    } finally {
      store.close();
    }
  });
  it.each(['fail-auth', 'invalid', 'invent-command', 'outside'])(
    'preserves QA and rounds on %s',
    async (mode) => {
      const store = await storeFor();
      try {
        const before = store.getTask(task)!;
        if (['fail-auth', 'outside'].includes(mode)) await expect(qa(mode)).rejects.toThrow();
        else await qa(mode);
        expect(store.getTask(task)).toMatchObject({
          status: 'QA',
          attempt: before.attempt,
          review_ref: before.review_ref,
          test_reports: [],
          lease_owner: null,
        });
        expect(lastReviewFailure(store, store.getTask(task)!)).not.toBeNull();
        expect(store.getTask(task + '-D1')).toBeUndefined();
        if (mode !== 'outside') {
          await qa();
          expect(store.getTask(task)!.status).toBe('DONE');
          expect(lastReviewFailure(store, store.getTask(task)!)).toBeNull();
        }
      } finally {
        store.close();
      }
    },
  );
  it.each(['allure-results/stale.json', '.vite/stale.json'])(
    'rejects previous residue %s as infrastructure and preserves QA before model launch',
    async (file) => {
      const common = path.resolve(repo, git(repo, 'rev-parse', '--git-common-dir'));
      fs.mkdirSync(path.join(common, 'info'), { recursive: true });
      fs.appendFileSync(path.join(common, 'info/exclude'), '\nallure-results/\n.vite/\n');
      fs.mkdirSync(path.dirname(path.join(tree(), file)), { recursive: true });
      fs.writeFileSync(path.join(tree(), file), 'residue');
      await expect(qa()).rejects.toThrow(
        'residuo previo a la verificación: Eval modified a forbidden path: ' + JSON.stringify(file),
      );
      const store = await storeFor();
      try {
        expect(store.getTask(task)).toMatchObject({
          status: 'QA',
          attempt: 0,
          test_reports: [],
          lease_owner: null,
        });
        expect(store.getTask(task)!.review_ref).toBeTruthy();
        expect(fs.readFileSync(launches, 'utf8')).toBe('');
      } finally {
        store.close();
      }
    },
  );
  it('retains QA on runtime verifier infrastructure failure before model launch', async () => {
    vi.spyOn(verifier, 'runIsolatedVitest').mockRejectedValueOnce(
      new Error('Vitest infrastructure failed: missing report'),
    );
    await expect(qa()).rejects.toThrow(/infrastructure|Worker failed/);
    const store = await storeFor();
    try {
      expect(store.getTask(task)).toMatchObject({
        status: 'QA',
        attempt: 0,
        test_reports: [],
        lease_owner: null,
      });
      expect(store.getTask(task)!.review_ref).toBeTruthy();
      expect(fs.readFileSync(launches, 'utf8')).toBe('');
    } finally {
      store.close();
    }
  });
  it('shares Reviewer round cap, persists defects and escalates without an extra round', async () => {
    const db = new DatabaseSync(path.join(repo, '.git/softwareagents/work.sqlite3'));
    const row = db.prepare('SELECT review_reports FROM tasks WHERE key = ?').get(task)!;
    const approved = JSON.parse(row.review_reports as string);
    const previous = Array.from({ length: REVIEW_MAX_REWORK_ROUNDS }, (_, round) => ({
      ...approved[0],
      execution_id: 'history-' + round,
      report: {
        verdict: 'request_changes',
        findings: [
          { severity: 'major', file: 'server/src/audit.ts', summary: 'Gap', suggestion: 'Fix' },
        ],
      },
    }));
    db.prepare('UPDATE tasks SET attempt = ?, review_reports = ? WHERE key = ?').run(
      REVIEW_MAX_REWORK_ROUNDS,
      JSON.stringify([...previous, ...approved]),
      task,
    );
    db.close();
    await qa('fail');
    const store = await storeFor();
    try {
      expect(store.getTask(task)).toMatchObject({
        status: 'WAITING_HUMAN',
        attempt: REVIEW_MAX_REWORK_ROUNDS,
      });
      expect(store.getTask(task)!.test_reports).toHaveLength(1);
      expect(store.getTask(task + '-D1')!.defect_context!.ac).toBe('AC-001');
      expect(store.listDecisions()[0].context).toContain('rework_limit');
      const first = store.getTask(task)!.test_reports![0];
      const defect = store.getTask(task + '-D1')!;
      await store.resolveDecision(store.listDecisions()[0].id, 'inspect', 'human', () => {});
      // Whitespace-only content changes retain the same defect identity at the same SHA.
      const db = new DatabaseSync(path.join(repo, '.git/softwareagents/work.sqlite3'));
      db.prepare('UPDATE tasks SET defect_context = ? WHERE key = ?').run(
        JSON.stringify({
          ...defect.defect_context,
          summary: '  Missing  edge case\n',
          reproduction: ' Open audit with no entries  ',
        }),
        task + '-D1',
      );
      db.close();
      await qa('fail');
      expect(store.getTask(task)).toMatchObject({
        status: 'WAITING_HUMAN',
        attempt: REVIEW_MAX_REWORK_ROUNDS,
      });
      const reports = store.getTask(task)!.test_reports!;
      expect(reports).toHaveLength(2);
      expect(reports[0]).toEqual(first);
      expect(reports[1].execution_id).not.toBe(first.execution_id);
      for (const report of reports)
        expect(JSON.parse(fs.readFileSync(report.artifact_path, 'utf8'))).toEqual(report);
      expect(store.listTasks().filter((t) => t.defect_context?.task === task)).toHaveLength(1);
      expect(store.getTask(task + '-D2')).toBeUndefined();
    } finally {
      store.close();
    }
  });
  it('executes additional allowlisted commands only in the runtime, then obtains the report', async () => {
    await qa('request-command');
    const store = await storeFor();
    try {
      expect(store.getTask(task)!.status).toBe('DONE');
      const commands = store.getTask(task)!.test_reports![0].report.commands;
      expect(commands).toHaveLength(2);
      expect(commands[1]).toEqual(commands[0]);
      const logs = fs
        .readFileSync(launches, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(logs).toHaveLength(2);
      expect(logs[1].data.commandAllowlist).toEqual([]);
    } finally {
      store.close();
    }
  });
  it('does not declare DONE for untested acceptance', async () => {
    await qa('not_tested');
    const store = await storeFor();
    try {
      expect(store.getTask(task)).toMatchObject({ status: 'QA', attempt: 0 });
      expect(store.getTask(task)!.test_reports).toHaveLength(1);
      expect(store.getTask('FEAT-001-T02')!.status).toBe('DRAFT');
    } finally {
      store.close();
    }
  });
  it('refuses a changed SHA and unapproved reviews before any QA launch', async () => {
    const store = await storeFor();
    const approved = store.getTask(task)!.review_reports;
    store.close();
    const db = new DatabaseSync(path.join(repo, '.git/softwareagents/work.sqlite3'));
    try {
      db.prepare('UPDATE tasks SET review_reports = ? WHERE key = ?').run('[]', task);
      await expect(qa()).rejects.toThrow(/approved review/);
      db.prepare('UPDATE tasks SET review_reports = ? WHERE key = ?').run(
        JSON.stringify(approved),
        task,
      );
    } finally {
      db.close();
    }
    git(tree(), '-c', 'core.hooksPath=', 'commit', '--allow-empty', '-m', 'changed');
    await expect(qa()).rejects.toThrow(/SHA|HEAD/);
    expect(fs.readFileSync(launches, 'utf8')).toBe('');
  });
});
