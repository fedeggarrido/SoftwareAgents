import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditLog } from '../src/auditLog.js';
import { parseProjects } from '../src/configPersistence.js';
import { ExecutionTelemetry, TelemetrySink } from '../src/telemetry.js';
import { openBudgetDecision, watchExecutionBudget } from '../src/usageBudgets.js';
import { runUsageCommand } from '../src/usageCommand.js';
import {
  admissionBudgetReason,
  aggregateUsage,
  usageEntry,
  usageSummary,
} from '../src/usageLedger.js';
import { WorkerLifecycle } from '../src/workerLifecycle.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import type { WorkStore } from '../src/workstore/WorkStore.js';
import { operatorToken } from './helpers/operatorToken.js';

vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));

describe('SA-037 usage ledger and budgets', () => {
  let root: string;
  let store: WorkStore;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-usage-'));
    vi.stubEnv('HOME', path.join(root, 'home'));
    vi.stubEnv('USERPROFILE', path.join(root, 'home'));
    execFileSync('git', ['init', root], { windowsHide: true, stdio: 'pipe' });
    store = await openWorkStore({ repositoryPath: root, projectId: 'test' });
    store.createFeature({
      key: 'FEAT-001',
      status: 'approved',
      doc_path: 'spec.md',
      git_sha: 'abc',
    });
    store.createTask({ key: 'task', type: 'code', feature_key: 'FEAT-001', status: 'READY' });
  });
  afterEach(() => {
    vi.useRealTimers();
    store?.close();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function execution(key = 'execution', start = '2026-10-29T12:00:00.000Z') {
    await store.createExecution({
      key,
      task_key: 'task',
      agent_template_version: '1',
      executor: 'claude',
      model_id: 'model',
      model_tier: 'standard',
      session_id: null,
      pid: null,
      started_at: start,
      system_prompt_hash: 'hash',
      project_brain_sha: 'sha',
      task_version: store.getTask('task')!.version,
      tool_policy_version: '1',
    });
    return store.getExecution(key)!;
  }
  it('backfills retained run evidence, previews without writes and never replaces a row', async () => {
    for (const name of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
      vi.stubEnv(name, undefined);
    await execution();
    fs.mkdirSync(path.join(root, 'home'), { recursive: true });
    fs.mkdirSync(path.join(root, '.softwareagents'));
    fs.writeFileSync(
      path.join(root, '.softwareagents/project.yaml'),
      'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: test\nname: Test\nrepo:\n  remote: https://example.invalid/test.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n',
    );
    const runs = path.join(root, '.git/softwareagents/runs');
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(
      path.join(runs, 'execution.jsonl'),
      [
        { type: 'telemetry', observation: { kind: 'model', model: 'observed' } },
        {
          type: 'telemetry',
          observation: { kind: 'usage', input: 100, output: 20, cacheRead: 60, cacheCreate: 10 },
        },
        { type: 'finished', endedAt: '2026-10-29T12:01:00.000Z' },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );
    const output = vi.fn();
    const database = path.join(root, '.git/softwareagents/work.sqlite3');
    const before = fs.readFileSync(database);
    await runUsageCommand(['backfill', '--dry-run', '--json'], root, output);
    expect(fs.readFileSync(database)).toEqual(before);
    expect(store.listUsage()).toEqual([]);
    expect(fs.existsSync(path.join(root, 'home/.pixel-agents'))).toBe(false);
    expect(JSON.parse(output.mock.calls[0][0]).entries[0]).toMatchObject({
      source: 'backfill',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 60,
      model: 'observed',
      durationMs: 60000,
      costUsd: null,
      attempt: null,
    });
    fs.mkdirSync(path.join(root, 'home/.pixel-agents'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'home/.pixel-agents/config.json'),
      JSON.stringify({
        projects: {
          test: {
            autonomyLevel: 'A0',
            allowedExecutors: [],
            telemetry: {
              prices: { observed: { input: 10, output: 20, cacheRead: 1, cacheCreate: 2 } },
            },
          },
        },
      }),
    );
    const second = await execution('second');
    const telemetry = new ExecutionTelemetry(new TelemetrySink(path.join(root, '.git'), 'test'), {
      executionId: second.key,
      taskKey: 'task',
      executor: 'claude',
      agent: 'developer',
      role: 'developer',
      model: 'observed',
    });
    telemetry.observe({ kind: 'model', model: 'observed' });
    telemetry.observe({ kind: 'usage', input: 100, output: 20, cacheRead: 60, cacheCreate: 10 });
    await telemetry.finish('ok');
    operatorToken(path.join(root, 'home'));
    await runUsageCommand(['backfill', '--json'], root, output);
    const rows = store.listUsage();
    expect(rows).toHaveLength(2);
    expect(rows[0].costUsd).toBe(0.00078);
    expect(rows[1]).toMatchObject({ source: 'backfill', inputTokens: 100, costUsd: 0.00078 });
    const backup = JSON.parse(output.mock.calls.at(-1)![0]).backup;
    expect(fs.existsSync(path.join(backup, 'work.sqlite3'))).toBe(true);
    expect(
      fs.readFileSync(path.join(root, 'home/.pixel-agents/audit/test.jsonl'), 'utf8'),
    ).toContain('usage_backfill');
    await runUsageCommand(['backfill', '--json'], root, output);
    expect(store.listUsage()).toEqual(rows);
    expect(JSON.parse(output.mock.calls.at(-1)![0]).entries).toEqual([]);
    vi.stubEnv('SA_WORKER', '1');
    await expect(runUsageCommand(['backfill', '--dry-run'], root, output)).rejects.toThrow(
      'human ingress',
    );
  });
  it('reports unknown costs for an empty ledger, including DONE tasks', () => {
    const summary = usageSummary([], [{ ...store.getTask('task')!, status: 'DONE' }]);
    expect(summary.total.costUsd).toBeNull();
    expect(summary.total.costPerResolvedTaskUsd).toBeNull();
  });
  it('migrates v15 without losing operational records and reads usage without migrating', async () => {
    await execution();
    store.close();
    const { DatabaseSync } = await import('node:sqlite');
    const file = path.join(root, '.git/softwareagents/work.sqlite3');
    const db = new DatabaseSync(file);
    db.exec(
      'DROP TABLE usage_ledger; ALTER TABLE tasks DROP COLUMN pr_observation; ALTER TABLE tasks DROP COLUMN pr_status; UPDATE schema_version SET version = 15',
    );
    db.close();
    store = await openWorkStore({ repositoryPath: root, projectId: 'test' });
    expect(store.getExecution('execution')?.task_key).toBe('task');
    expect(store.getTask('task')?.feature_key).toBe('FEAT-001');
    expect(store.listUsage()).toEqual([]);
    fs.mkdirSync(path.join(root, '.softwareagents'));
    fs.writeFileSync(
      path.join(root, '.softwareagents/project.yaml'),
      'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: test\nname: Test\nrepo:\n  remote: https://example.invalid/test.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n',
    );
    await store.recordUsage(
      usageEntry(store.getExecution('execution')!, store.getTask('task')!, {}),
    );
    const output = vi.fn();
    const before = fs.readFileSync(file);
    await runUsageCommand(['--feature', 'FEAT-001', '--day', '2026-10-29', '--json'], root, output);
    expect(JSON.parse(output.mock.calls[0][0]).total.executions).toBe(1);
    expect(JSON.parse(output.mock.calls[0][0]).byRole.unknown).toMatchObject({
      distinctPrefixHashes: 0,
      unknownPrefixExecutions: 1,
      cacheHitRate: null,
    });
    await runUsageCommand(['--feature', 'FEAT-001'], root, output);
    expect(output.mock.calls.at(-1)![0]).toContain(
      'Role unknown: cache hit rate unknown; distinct prefixHash 0; unknown prefix executions 1',
    );
    await runUsageCommand(['--feature', 'FEAT-002', '--json'], root, output);
    expect(JSON.parse(output.mock.calls.at(-1)![0]).byRole).toEqual({});
    expect(fs.readFileSync(file)).toEqual(before);
    await expect(runUsageCommand(['--day', '2026-99-99'], root, output)).rejects.toThrow('Usage:');
    await expect(runUsageCommand(['--json', '--json'], root, output)).rejects.toThrow('Usage:');
  });
  it('persists fake telemetry once, retains records after reopen, and scopes feature/day cost per DONE', async () => {
    const record = await execution();
    const telemetry = new ExecutionTelemetry(new TelemetrySink(path.join(root, '.git'), 'test'), {
      executionId: record.key,
      taskKey: 'task',
      executor: 'claude',
      agent: 'developer',
      role: 'developer',
      model: 'model',
    });
    telemetry.observe({ kind: 'usage', input: 100, output: 20, cacheRead: 60, cacheCreate: 10 });
    telemetry.observe({ kind: 'model', model: 'model' });
    telemetry.observe({ kind: 'prefix', hash: 'a'.repeat(64) });
    const entry = usageEntry(
      record,
      store.getTask('task')!,
      telemetry.usageAttributes,
      { model: { input: 10, output: 20, cacheRead: 1, cacheCreate: 2 } },
      '2026-10-29T12:01:00.000Z',
    );
    await store.recordUsage(entry);
    await store.recordUsage(entry);
    expect(store.listUsage()).toHaveLength(1);
    expect(store.listUsage()[0]).toMatchObject({
      durationMs: 60_000,
      attempt: 1,
      cacheHitRate: 0.6,
      costUsd: 0.00078,
      role: 'developer',
      prefixHash: 'a'.repeat(64),
    });
    const other = await execution('other', '2026-10-28T12:00:00.000Z');
    await store.recordUsage({ ...entry, executionId: other.key, day: '2026-10-28', costUsd: 2 });
    store.close();
    store = await openWorkStore({ repositoryPath: root, projectId: 'test' });
    const tasks = [{ ...store.getTask('task')!, status: 'DONE' as const }];
    const summary = usageSummary(store.listUsage(), tasks, {
      feature: 'FEAT-001',
      day: '2026-10-29',
    });
    expect(summary.total).toMatchObject({
      executions: 1,
      resolvedTasks: 1,
      costPerResolvedTaskUsd: 0.00078,
      cacheHitRate: 0.6,
    });
    expect(summary.byFeature['FEAT-001']).toEqual(summary.total);
    expect(summary.byDay['2026-10-29']).toEqual(summary.total);
    expect(summary.byRole.developer).toMatchObject({
      cacheHitRate: 0.6,
      distinctPrefixHashes: 1,
      unknownPrefixExecutions: 0,
    });
    expect(usageSummary(store.listUsage(), tasks, { feature: 'FEAT-002' }).total.executions).toBe(
      0,
    );
    expect(
      admissionBudgetReason({ maxTokensPerDay: 120 }, store.listUsage(), 'task', '2026-10-29'),
    ).toBe('maxTokensPerDay');
    expect(admissionBudgetReason({ maxAttemptsPerTask: 2 }, store.listUsage(), 'task')).toBe(
      'maxAttemptsPerTask',
    );
    expect(admissionBudgetReason(undefined, store.listUsage(), 'task')).toBeUndefined();
    const entries = store.listUsage();
    const cost = entries.reduce((n, e) => n + (e.costUsd ?? 0), 0);
    const tokens = entries.reduce((n, e) => n + (e.inputTokens ?? 0) + (e.outputTokens ?? 0), 0);
    // All days and all roles count for this task; other tasks and unknown counters do not.
    const mixed = [
      ...entries,
      { ...entry, taskKey: 'foreign', costUsd: 100, inputTokens: 100_000 },
      { ...entry, costUsd: null, inputTokens: null, outputTokens: null },
    ];
    expect(admissionBudgetReason({ maxCostUsd: cost }, mixed, 'task')).toBe('maxCostUsd');
    expect(admissionBudgetReason({ maxCostUsd: cost + 1 }, mixed, 'task')).toBeUndefined();
    expect(admissionBudgetReason({ maxTokens: tokens }, mixed, 'task')).toBe('maxTokens');
    expect(admissionBudgetReason({ maxTokens: tokens + 1 }, mixed, 'task')).toBeUndefined();
    const unknown = [{ ...entry, costUsd: null, inputTokens: null, outputTokens: null }];
    expect(admissionBudgetReason({ maxCostUsd: 1, maxTokens: 1 }, unknown, 'task')).toBeUndefined();
    expect(admissionBudgetReason({ maxCostUsd: 0 }, [], 'task')).toBe('maxCostUsd');
    expect(admissionBudgetReason({ maxTokens: 0 }, [], 'task')).toBe('maxTokens');
  });
  it.each(['maxCostUsd', 'maxTokens'])('audits and suspends admission for %s', async (reason) => {
    await openBudgetDecision(store, 'task', reason);
    expect(
      new AuditLog()
        .read('test')
        .some(
          (row) =>
            !row.corrupt &&
            row.entry.taskKey === 'task' &&
            row.entry.outcome.status === 'budget_exceeded' &&
            row.entry.outcome.reason === reason,
        ),
    ).toBe(true);
    expect(store.getTask('task')?.status).toBe('WAITING_HUMAN');
    expect(
      store.listDecisions().some((d) => d.context.includes(`usage-budget/task/${reason}`)),
    ).toBe(true);
  });
  it('cancels a fake handle at the minute cap, drains closure, then suspends and opens a decision', async () => {
    vi.useFakeTimers();
    const lifecycle = new WorkerLifecycle(store, 'task');
    await lifecycle.claim();
    const record = await execution();
    const cancel = vi.fn();
    await lifecycle.running(cancel);
    let exceeded = false;
    const stop = watchExecutionBudget({ maxExecutionMinutes: 1 }, cancel, () => {
      exceeded = true;
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exceeded).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    // The fake executor reports finished only after cancellation; no OS process is launched.
    await store.closeExecution(record.key, lifecycle.owner);
    await store.recordUsage(
      usageEntry(store.getExecution(record.key)!, store.getTask('task')!, {}),
    );
    stop();
    vi.useRealTimers();
    await lifecycle.idleForDecision('execution_time');
    await openBudgetDecision(store, 'task', 'execution_time');
    await openBudgetDecision(store, 'task', 'execution_time');
    expect(store.getTask('task')?.status).toBe('WAITING_HUMAN');
    expect(store.listDecisions()).toHaveLength(1);
    expect(store.listDecisions()[0].context).toContain('¿ampliar presupuesto?');
    expect(store.getExecution(record.key)?.tree_closed_at).toBeTruthy();
    expect(store.listUsage()).toHaveLength(1);
  });
  it('retains unknown usage when recovering a dead worker before process registration', async () => {
    const lifecycle = new WorkerLifecycle(store, 'task');
    await lifecycle.claim();
    await execution();
    await lifecycle.stopHeartbeat();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(root, '.git/softwareagents/work.sqlite3'));
    db.exec("UPDATE tasks SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE key = 'task'");
    db.close();
    await store.recoverExpiredLeases();
    expect(store.listUsage()).toHaveLength(1);
    expect(store.listUsage()[0]).toMatchObject({
      executionId: 'execution',
      inputTokens: null,
      costUsd: null,
    });
    await store.recoverExpiredLeases();
    expect(store.listUsage()).toHaveLength(1);
  });
  it('leaves unconfigured execution timers unchanged and validates optional operator caps', () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stop = watchExecutionBudget(undefined, cancel, vi.fn());
    vi.advanceTimersByTime(86_400_000);
    expect(cancel).not.toHaveBeenCalled();
    stop();
    const policy = {
      autonomyLevel: 'A1',
      allowedExecutors: ['claude'],
      budgets: { maxExecutionMinutes: 5, maxAttemptsPerTask: 3, maxTokensPerDay: 1000 },
    };
    expect(parseProjects({ test: policy }).test.budgets).toEqual(policy.budgets);
    expect(
      parseProjects({ test: { ...policy, budgets: { maxAttemptsPerTask: -1 } } }).test,
    ).toBeUndefined();
  });
});

it('groups cache measurements by role after feature filtering and leaves legacy prefixes unknown', () => {
  const base = {
    taskKey: 'T1',
    featureKey: 'FEAT-001',
    day: '2026-10-30',
    role: 'developer',
    prefixHash: 'a'.repeat(64),
    inputTokens: 100,
    cacheReadTokens: 80,
  };
  const entries = [
    base,
    { ...base, prefixHash: 'b'.repeat(64), cacheReadTokens: 20 },
    { ...base, prefixHash: null, cacheReadTokens: null },
    { ...base, role: 'qa', prefixHash: 'c'.repeat(64), featureKey: 'FEAT-002' },
    { ...base, role: undefined, prefixHash: undefined },
  ] as import('../src/usageLedger.js').UsageEntry[];
  const summary = usageSummary(entries, [], { feature: 'FEAT-001' });
  expect(summary.byRole.developer).toMatchObject({
    executions: 3,
    cacheHitRate: 0.5,
    distinctPrefixHashes: 2,
    unknownPrefixExecutions: 1,
  });
  expect(summary.byRole.unknown).toMatchObject({
    executions: 1,
    distinctPrefixHashes: 0,
    unknownPrefixExecutions: 1,
  });
  expect(summary.byRole.qa).toBeUndefined();
});

it('sums known costs and reports coverage when historical rows lack data', () => {
  const row = (cost: number | null, input: number | null, cached: number | null) =>
    ({ costUsd: cost, inputTokens: input, cacheReadTokens: cached }) as never;
  const total = aggregateUsage([row(0.5, 100, 80), row(null, null, null), row(0.25, 100, 20)], [
    { key: 'T1', status: 'DONE' },
  ] as never);
  expect(total).toMatchObject({
    executions: 3,
    costUsd: 0.75,
    costCoverage: 2,
    tokenCoverage: 2,
    cacheHitRate: 0.5,
    costPerResolvedTaskUsd: 0.75,
  });
  expect(aggregateUsage([], [])).toMatchObject({ costUsd: null, costPerResolvedTaskUsd: null });
});
