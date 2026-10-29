import type { ProjectOperatorConfig, TelemetryConfig } from '../../core/src/project.js';
import { addTelemetryTotals, emptyTelemetryTotals } from './telemetryCommand.js';
import type { ExecutionRecord, TaskRecord } from './workstore/WorkStore.js';

export interface UsageEntry {
  source?: 'backfill';
  executionId: string;
  taskKey: string;
  featureKey: string | null;
  day: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  attempt: number | null;
  executor: string;
  model: string;
  tier: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreateTokens: number | null;
  cacheHitRate: number | null;
  costUsd: number | null;
  quotaBefore: unknown;
  quotaAfter: unknown;
}

export function usageEntry(
  execution: ExecutionRecord,
  task: TaskRecord,
  attributes: Readonly<Record<string, string | number>>,
  prices?: TelemetryConfig['prices'],
  endedAt = new Date().toISOString(),
  quotaBefore: unknown = null,
  quotaAfter: unknown = null,
): UsageEntry {
  const totals = emptyTelemetryTotals();
  addTelemetryTotals(totals, { ...attributes }, prices);
  const known = (value: number | 'unknown') => (typeof value === 'number' ? value : null);
  return {
    executionId: execution.key,
    taskKey: execution.task_key,
    featureKey: task.feature_key,
    day: execution.started_at.slice(0, 10),
    startedAt: execution.started_at,
    endedAt,
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(execution.started_at)),
    attempt: task.attempt + 1,
    executor: execution.executor,
    model: String(attributes['gen_ai.response.model'] ?? execution.model_id),
    tier: execution.model_tier ?? null,
    inputTokens: known(totals.inputTokens),
    outputTokens: known(totals.outputTokens),
    cacheReadTokens: known(totals.cacheReadTokens),
    cacheCreateTokens: known(totals.cacheCreateTokens),
    cacheHitRate: known(totals.cacheHitRate),
    costUsd: known(totals.costUsd),
    quotaBefore,
    quotaAfter,
  };
}

export function aggregateUsage(entries: UsageEntry[], tasks: Pick<TaskRecord, 'key' | 'status'>[]) {
  // Sum what is known; null only when nothing is. Historical executions without run logs
  // leave gaps, so *Coverage says how many executions each figure covers (a lower bound).
  const known = (key: keyof UsageEntry) => entries.filter((entry) => entry[key] !== null);
  const sum = (
    key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreateTokens' | 'costUsd',
  ) => {
    const rows = known(key);
    return rows.length ? rows.reduce((n, entry) => n + (entry[key] as number), 0) : null;
  };
  const inputTokens = sum('inputTokens');
  const costUsd = sum('costUsd');
  // Hit rate only over executions that report both counters.
  const both = entries.filter((e) => e.inputTokens !== null && e.cacheReadTokens !== null);
  const bothInput = both.reduce((n, e) => n + e.inputTokens!, 0);
  const resolvedTasks = tasks.filter((task) => task.status === 'DONE').length;
  const durations = known('durationMs');
  return {
    executions: entries.length,
    durationMs: durations.length ? durations.reduce((n, e) => n + e.durationMs!, 0) : null,
    inputTokens,
    outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadTokens'),
    cacheCreateTokens: sum('cacheCreateTokens'),
    costUsd,
    costCoverage: known('costUsd').length,
    tokenCoverage: known('inputTokens').length,
    cacheHitRate:
      bothInput > 0 ? both.reduce((n, e) => n + e.cacheReadTokens!, 0) / bothInput : null,
    resolvedTasks,
    costPerResolvedTaskUsd: resolvedTasks && costUsd !== null ? costUsd / resolvedTasks : null,
  };
}

export function usageSummary(
  entries: UsageEntry[],
  tasks: TaskRecord[],
  filter: { feature?: string; day?: string } = {},
) {
  const selected = entries.filter(
    (e) =>
      (!filter.feature || e.featureKey === filter.feature) && (!filter.day || e.day === filter.day),
  );
  const scopedTasks = tasks.filter(
    (t) =>
      (!filter.feature || t.feature_key === filter.feature) &&
      (!filter.day || selected.some((e) => e.taskKey === t.key)),
  );
  const groups = (key: 'taskKey' | 'featureKey' | 'day') =>
    Object.fromEntries(
      [...new Set(selected.map((e) => e[key] ?? 'unassigned'))].map((value) => {
        const rows = selected.filter((e) => (e[key] ?? 'unassigned') === value);
        return [
          value,
          aggregateUsage(
            rows,
            scopedTasks.filter((t) => rows.some((e) => e.taskKey === t.key)),
          ),
        ];
      }),
    );
  return {
    total: aggregateUsage(selected, scopedTasks),
    byTask: groups('taskKey'),
    byFeature: groups('featureKey'),
    byDay: groups('day'),
  };
}

/** Observational daily cap: unknown counters and concurrent in-flight usage are not reservations. */
export function admissionBudgetReason(
  budgets: ProjectOperatorConfig['budgets'],
  entries: UsageEntry[],
  task: string,
  day = new Date().toISOString().slice(0, 10),
  executionCount = entries.filter((e) => e.taskKey === task).length,
): string | undefined {
  if (budgets?.maxAttemptsPerTask !== undefined && executionCount >= budgets.maxAttemptsPerTask)
    return 'maxAttemptsPerTask';
  const tokens = entries
    .filter((e) => e.day === day)
    .reduce((n, e) => n + (e.inputTokens ?? 0) + (e.outputTokens ?? 0), 0);
  if (budgets?.maxTokensPerDay !== undefined && tokens >= budgets.maxTokensPerDay)
    return 'maxTokensPerDay';
  return undefined;
}
