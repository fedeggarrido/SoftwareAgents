import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { parseEvalArgs, runEvalCommand } from '../src/evalCommand.js';
import { assertEvalRunAllowed } from '../src/evalGuard.js';
import {
  buildEvalReport,
  evalResultsDirectory,
  parseEvalRecord,
  readEvalRecords,
} from '../src/evalReport.js';
import { evalGit, type EvalTask, loadEvalTasks, parseEvalTask } from '../src/evalTasks.js';
import { EXECUTOR_PROBE_CATALOG } from '../src/executorProbes.js';
import { readExecutorSlots } from '../src/executorSlots.js';
import { loadWorkerAgentSpec } from '../src/worker.js';
import { readyProbeFor } from './helpers/readyProbe.js';

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: () => process.env.HOME ?? actual.homedir() };
});

const sourceRoot = path.resolve(__dirname, '../..');
const fake = path.join(__dirname, 'fixtures/fake-eval-cli.cjs');
const ready = readyProbeFor(EXECUTOR_PROBE_CATALOG);
let root: string;
let repo: string;
let task: EvalTask;
let configFile: string;
let launches: string;
let initialConfig: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  for (const [key, value] of Object.entries({
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, 'codex'),
    GIT_AUTHOR_NAME: 'Test',
    GIT_COMMITTER_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'empty-gitconfig'),
    SA_TEST_TELEMETRY: '1',
    SA_EVAL_FAKE_LOG: path.join(root, 'launches.jsonl'),
  }))
    vi.stubEnv(key, value);
  for (const key of [
    'CI',
    'SA_MANAGED_EXECUTION',
    'SA_AUTOPILOT',
    'SA_WORKER',
    'CLAUDECODE',
    'SA_EVAL_FAKE_MODE',
  ])
    vi.stubEnv(key, undefined);
  launches = process.env.SA_EVAL_FAKE_LOG!;
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL!, '');
  evalGit(repo, ['init', '-b', 'main']);
  fs.mkdirSync(path.join(repo, '.softwareagents/evals'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.softwareagents/project.yaml'),
    'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: test\nname: Test\nrepo:\n  remote: https://example.invalid/test.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n',
  );
  fs.mkdirSync(path.join(repo, 'scripts'));
  fs.copyFileSync(
    path.join(sourceRoot, 'scripts/remove-worktree.ps1'),
    path.join(repo, 'scripts/remove-worktree.ps1'),
  );
  fs.mkdirSync(path.join(repo, 'server/__tests__'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'answer.txt'), 'broken');
  evalGit(repo, ['add', '.']);
  evalGit(repo, ['commit', '-m', 'base']);
  const baseCommit = evalGit(repo, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repo, 'answer.txt'), 'fixed');
  fs.writeFileSync(
    path.join(repo, 'server/__tests__/answer.test.ts'),
    "import { it, expect } from 'vitest'; import { readFileSync } from 'fs'; import { resolve } from 'path';\nit('repairs answer', () => expect(readFileSync(resolve(import.meta.dirname, '../../answer.txt'), 'utf8')).toBe('fixed'));\n",
  );
  evalGit(repo, ['add', '.']);
  evalGit(repo, ['commit', '-m', 'fix']);
  task = {
    version: 1,
    id: 'answer',
    baseCommit,
    fixCommit: evalGit(repo, ['rev-parse', 'HEAD']),
    brief: 'PROMPT_SECRET_MARKER: repair answer.txt',
    timeoutMin: 1,
    criteria: [{ file: 'server/__tests__/answer.test.ts', testName: 'repairs answer' }],
  };
  fs.writeFileSync(path.join(repo, '.softwareagents/evals/answer.json'), JSON.stringify(task));
  configFile = path.join(root, '.pixel-agents/config.json');
  fs.mkdirSync(path.dirname(configFile));
  const rule = parse(
    fs.readFileSync(path.join(sourceRoot, '.softwareagents/agents/model-policy.yaml'), 'utf8'),
  ).tierRule;
  initialConfig = JSON.stringify({
    projects: {
      test: {
        autonomyLevel: 'A1',
        allowedExecutors: ['claude', 'codex'],
        binaryPaths: { claude: process.execPath, codex: process.execPath },
        quotaThresholds: { claude: 0, codex: 0 },
        concurrency: { maxExecutions: 1, perExecutor: { claude: 1, codex: 1 } },
        modelTiers: {
          maxTier: 'standard',
          rule,
          tiers: {
            economy: {
              candidates: [
                { executor: 'claude', model: 'claude-test' },
                { executor: 'codex', model: 'gpt-test', effort: 'low' },
              ],
            },
            standard: {
              candidates: [
                { executor: 'claude', model: 'claude-test' },
                { executor: 'codex', model: 'gpt-test' },
              ],
              fallbackTo: 'economy',
            },
          },
        },
        telemetry: {
          prices: {
            'claude-test': { input: 1, output: 2, cacheRead: 0.1, cacheCreate: 1.25 },
            'gpt-test': { input: 1, output: 2, cacheRead: 0.1 },
          },
        },
      },
    },
  });
  fs.writeFileSync(configFile, initialConfig);
});
afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // Every eval tree was cleaned through the safe removal script. Never traverse a junction.
  expect(
    fs.existsSync(path.join(repo, '.worktrees'))
      ? fs.readdirSync(path.join(repo, '.worktrees'))
      : [],
  ).toEqual([]);
  fs.rmSync(root, { recursive: true, force: true });
});
const readRecords = () => readEvalRecords(evalResultsDirectory(path.join(repo, '.git'), 'test'));
async function run(executor: 'claude' | 'codex', extra: string[] = []) {
  const output: string[] = [];
  await runEvalCommand(
    [
      'run',
      '--task',
      'answer',
      '--executor',
      executor,
      '--tier',
      'economy',
      '--repeat',
      '1',
      '--yes',
      '--json',
      ...extra,
    ],
    {
      cwd: repo,
      log: (line) => output.push(line),
      worker: { binaryArgs: [fake, executor], probe: ready },
    },
  );
  return JSON.parse(output[0]);
}

describe('eval task declarations and no-launch commands', () => {
  it('validates all five real historical tasks without launching or writing results', async () => {
    const tasks = loadEvalTasks(sourceRoot);
    expect(tasks).toHaveLength(5);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(5);
    const probe = vi.fn(ready);
    for (const command of ['list', 'validate', 'report']) {
      const log = vi.fn();
      await runEvalCommand([command, '--json'], { cwd: repo, log, worker: { probe } });
      expect(JSON.parse(log.mock.calls[0][0])).toBeDefined();
    }
    expect(probe).not.toHaveBeenCalled();
    expect(fs.existsSync(launches)).toBe(false);
    expect(fs.existsSync(path.join(repo, '.git/softwareagents'))).toBe(false);
  });
  it('rejects unknown/nested fields, malformed refs, path traversal and wrong ancestry', () => {
    for (const change of [
      { authority: true },
      { id: 'all' },
      { baseCommit: 'HEAD' },
      { timeoutMin: 100 },
      { criteria: [{ ...task.criteria[0], command: 'anything' }] },
      { criteria: [{ file: '../../escape.test.ts', testName: '.' }] },
      { criteria: [{ ...task.criteria[0], testName: '[' }] },
    ])
      expect(() => parseEvalTask({ ...task, ...change })).toThrow();
    fs.writeFileSync(
      path.join(repo, '.softwareagents/evals/answer.json'),
      JSON.stringify({ ...task, baseCommit: task.fixCommit }),
    );
    expect(() => loadEvalTasks(repo)).toThrow('parent');
  });
  it('requires unique, explicit run flags and a bounded positive repetition count', () => {
    const valid = [
      'run',
      '--task',
      'all',
      '--executor',
      'codex',
      '--tier',
      'economy',
      '--repeat',
      '2',
    ];
    expect(parseEvalArgs(valid)).toMatchObject({ repeat: 2, yes: false });
    for (const argv of [
      [],
      ['run'],
      [...valid, '--repeat', '1'],
      [...valid, '--unknown'],
      valid.map((s) => (s === '2' ? '0' : s)),
      valid.map((s) => (s === '2' ? '21' : s)),
      ['report', '--yes'],
    ])
      expect(() => parseEvalArgs(argv)).toThrow();
  });
});

describe('operator-only quota guard', () => {
  it.each(['CI', 'SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])(
    'refuses %s even with --yes before prompting or launching',
    async (key) => {
      vi.stubEnv(key, 'false');
      const confirm = vi.fn();
      const probe = vi.fn(ready);
      await expect(
        runEvalCommand(
          [
            'run',
            '--task',
            'answer',
            '--executor',
            'codex',
            '--tier',
            'economy',
            '--repeat',
            '1',
            '--yes',
          ],
          { cwd: repo, confirm, worker: { probe } },
        ),
      ).rejects.toThrow(/forbidden|operator-only/);
      expect(confirm).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
      expect(fs.existsSync(launches)).toBe(false);
      expect(fs.existsSync(path.join(repo, '.git/softwareagents'))).toBe(false);
    },
  );
  it('treats even empty CI as defined', () =>
    expect(() => assertEvalRunAllowed({ CI: '' })).toThrow());
  it('prompts with the actual number of runs and cancellation launches nothing', async () => {
    const confirm = vi.fn(async () => false);
    await expect(
      runEvalCommand(
        ['run', '--task', 'all', '--executor', 'codex', '--tier', 'economy', '--repeat', '3'],
        { cwd: repo, confirm },
      ),
    ).rejects.toThrow('cancelled');
    expect(confirm).toHaveBeenCalledWith(3);
    expect(fs.existsSync(path.join(repo, '.git/softwareagents'))).toBe(false);
  });
  it.each(['disabled', 'level', 'maxTier', 'catalog'])(
    'respects Operator %s restrictions without changing config or probing',
    async (kind) => {
      const config = JSON.parse(initialConfig);
      const operator = config.projects.test;
      if (kind === 'disabled') operator.allowedExecutors = ['claude'];
      if (kind === 'level') operator.executorLevels = { codex: [] };
      if (kind === 'maxTier') {
        operator.modelTiers.maxTier = 'economy';
        delete operator.modelTiers.tiers.economy;
      }
      if (kind === 'catalog') delete operator.modelTiers;
      const contents = JSON.stringify(config);
      fs.writeFileSync(configFile, contents);
      await expect(run('codex')).rejects.toThrow();
      expect(fs.readFileSync(configFile, 'utf8')).toBe(contents);
      expect(fs.existsSync(launches)).toBe(false);
    },
  );
  it('maxExecutions=0 blocks in worker admission, launches nothing and cleans the tree', async () => {
    const config = JSON.parse(initialConfig);
    config.projects.test.concurrency.maxExecutions = 0;
    fs.writeFileSync(configFile, JSON.stringify(config));
    const result = await run('codex');
    expect(result.results[0].status).toBe('blocked');
    expect(fs.existsSync(launches)).toBe(false);
    expect(result.configurations[0]).toMatchObject({ attempts: 0, blocked: 1 });
  });
});

describe('worker-backed evals with fake CLIs', () => {
  it.each(['claude', 'codex'] as const)(
    '%s succeeds in a detached base tree and persists only metrics',
    async (executor) => {
      const before = evalGit(repo, ['rev-parse', 'HEAD']);
      const result = await run(executor);
      expect(result.results[0]).toMatchObject({
        status: 'success',
        repetition: 1,
        criteria: [true],
      });
      expect(result.configurations[0]).toMatchObject({
        successRate: 1,
        consistency: 'unknown',
        pareto: true,
      });
      expect(result.configurations[0].totals.inputTokens).toBe(executor === 'codex' ? 10 : 16);
      expect(result.configurations[0].totals.cacheReadTokens).toBe(4);
      expect(result.configurations[0].totals.outputTokens).toBe(5);
      expect(result.configurations[0].costPerSolvedTaskUsd).toBeGreaterThan(0);
      expect(readExecutorSlots('claude').count).toBe(0);
      expect(readExecutorSlots('codex').count).toBe(0);
      const launch = JSON.parse(fs.readFileSync(launches, 'utf8').trim());
      expect(launch.managed).toBe('worker');
      expect(launch.cwd).not.toBe(repo);
      expect(evalGit(repo, ['rev-parse', 'HEAD'])).toBe(before);
      expect(fs.readFileSync(path.join(repo, 'answer.txt'), 'utf8')).toBe('fixed');
      expect(fs.readFileSync(configFile, 'utf8')).toBe(initialConfig);
      expect(fs.existsSync(path.join(repo, '.softwareagents/evals/results.jsonl'))).toBe(false);
      const records = await readRecords();
      expect(records.invalidLines).toBe(0);
      expect(
        fs
          .readdirSync(evalResultsDirectory(path.join(repo, '.git'), 'test'))
          .every((name) => name.endsWith('.jsonl')),
      ).toBe(true);
      expect(JSON.stringify(records)).not.toMatch(
        /PROMPT_SECRET|OUTPUT_SECRET|instructions|append-system-prompt/,
      );
      expect(fs.existsSync(path.join(repo, '.git/softwareagents/work.sqlite3'))).toBe(false);
      for (const name of fs.readdirSync(path.join(repo, '.git/softwareagents/runs')))
        expect(
          fs.readFileSync(path.join(repo, '.git/softwareagents/runs', name), 'utf8'),
        ).not.toMatch(/PROMPT_SECRET|OUTPUT_SECRET|resultSummary/);
    },
    30_000,
  );
  it.each(['claude', 'codex'] as const)(
    '%s records a failing acceptance criterion',
    async (executor) => {
      vi.stubEnv('SA_EVAL_FAKE_MODE', 'criterion-fail');
      const result = await run(executor);
      expect(result.results[0]).toMatchObject({ status: 'criterion_failed', criteria: [false] });
      expect(result.configurations[0]).toMatchObject({
        successes: 0,
        successRate: 0,
        costPerSolvedTaskUsd: 'unknown',
      });
    },
    30_000,
  );
  it.each(['claude', 'codex'] as const)(
    '%s detects inconsistent repetitions and freezes Operator prices',
    async (executor) => {
      vi.stubEnv('SA_EVAL_FAKE_MODE', 'inconsistent');
      const log = vi.fn();
      await runEvalCommand(
        [
          'run',
          '--task',
          'all',
          '--executor',
          executor,
          '--tier',
          'economy',
          '--repeat',
          '2',
          '--yes',
          '--json',
        ],
        {
          cwd: repo,
          log,
          worker: { binaryArgs: [fake, executor], probe: ready },
        },
      );
      const result = JSON.parse(log.mock.calls[0][0]);
      expect(result.results.map((r: { status: string }) => r.status)).toEqual([
        'success',
        'criterion_failed',
      ]);
      expect(result.configurations[0]).toMatchObject({
        attempts: 2,
        successRate: 0.5,
        consistency: 0,
      });
      fs.writeFileSync(configFile, JSON.stringify({ projects: {} }));
      const out = vi.fn();
      await runEvalCommand(['report', '--json'], { cwd: repo, log: out });
      expect(JSON.parse(out.mock.calls[0][0]).configurations).toEqual(result.configurations);
    },
    30_000,
  );
  it.each(['claude', 'codex'] as const)(
    '%s detects an AgentSpec regression against the stored baseline',
    async (executor) => {
      await run(executor);
      const spec = loadWorkerAgentSpec();
      spec.identity.mission = 'REGRESSION_SPEC';
      const file = path.join(root, 'regression.json');
      fs.writeFileSync(file, JSON.stringify(spec));
      const result = await run(executor, ['--agent-spec', file]);
      expect(result.results[0].status).toBe('executor_error');
      expect(result.regressionDetected).toBe(true);
      const variant = result.configurations.find((c: { baseline: boolean }) => !c.baseline);
      expect(variant.regressions).toEqual([
        expect.objectContaining({ task: 'answer', baselineRate: 1, rate: 0 }),
      ]);
      expect(JSON.stringify(result)).not.toContain('REGRESSION_SPEC');
      const out = vi.fn();
      await runEvalCommand(['report', '--json'], { cwd: repo, log: out });
      expect(JSON.parse(out.mock.calls[0][0]).regressionDetected).toBe(true);
    },
    30_000,
  );
  it('restores a verifier corrupted by the executor', async () => {
    vi.stubEnv('SA_EVAL_FAKE_MODE', 'tamper');
    expect((await run('codex')).results[0].status).toBe('success');
  }, 30_000);
  it('never counts an unmatched test name as success', async () => {
    task.criteria[0].testName = 'no matching tests';
    fs.writeFileSync(path.join(repo, '.softwareagents/evals/answer.json'), JSON.stringify(task));
    expect((await run('codex')).results[0].status).toBe('criterion_failed');
  }, 30_000);
  it('keeps missing prices unknown and rejects content-bearing result fields', async () => {
    const config = JSON.parse(initialConfig);
    delete config.projects.test.telemetry;
    fs.writeFileSync(configFile, JSON.stringify(config));
    const result = await run('codex');
    expect(result.configurations[0]).toMatchObject({
      costPerSolvedTaskUsd: 'unknown',
      pareto: 'unknown',
    });
    expect(result.results[0].executionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(() => parseEvalRecord({ ...result.results[0], prompt: 'forbidden' })).toThrow();
    expect(() =>
      parseEvalRecord({ ...result.results[0], metrics: { output: 'forbidden' } }),
    ).toThrow();
  }, 30_000);
  it('rebuilds aggregates, Pareto and consistency from JSONL and counts invalid/duplicate rows', async () => {
    const result = await run('codex');
    const dir = evalResultsDirectory(path.join(repo, '.git'), 'test');
    const file = path.join(dir, `${result.runId}.jsonl`);
    fs.appendFileSync(file, 'partial\n' + JSON.stringify(result.results[0]) + '\n');
    const read = await readRecords();
    expect(read.invalidLines).toBe(2);
    expect(buildEvalReport(read.records).configurations).toEqual(result.configurations);
    const worse = {
      ...read.records[0],
      agentSpecHash: 'a'.repeat(64),
      baseline: false,
      price: { input: 100, output: 200, cacheRead: 50 },
    };
    const report = buildEvalReport([...read.records, worse]);
    expect(report.configurations.find((c) => !c.baseline)?.pareto).toBe(false);
  }, 30_000);
});
