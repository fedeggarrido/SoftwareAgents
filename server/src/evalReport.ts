import * as fs from 'fs';
import { createInterface } from 'readline';

import type { ModelTier } from '../../core/src/modelTier.js';
import type { TelemetryConfig } from '../../core/src/project.js';
import { resolveInside } from './pathGuard.js';
import { compileSchema, validateSchema } from './schemaValidation.js';
import { addTelemetryTotals, emptyTelemetryTotals } from './telemetryCommand.js';

export const EVAL_METRIC_FIELDS = [
  'softwareagents.executor',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'softwareagents.model.effort',
  'softwareagents.model.multiple',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.cache_read.input_tokens',
  'gen_ai.usage.cache_creation.input_tokens',
  'softwareagents.phase.preparation_ms',
  'softwareagents.phase.execution_ms',
  'softwareagents.phase.commit_guards_ms',
] as const;
type Price = NonNullable<TelemetryConfig['prices']>[string];
export interface EvalRecord {
  version: 1;
  runId: string;
  executionId?: string;
  project: string;
  task: string;
  taskHash: string;
  bankHash: string;
  baseCommit: string;
  executor: 'claude' | 'codex';
  tier: ModelTier;
  agentSpecHash: string;
  baseline: boolean;
  repetition: number;
  status: 'success' | 'criterion_failed' | 'criteria_tampered' | 'executor_error' | 'blocked';
  criteria: boolean[];
  durationMs: number;
  metrics: Record<string, string | number>;
  /** Snapshot ONLY from Operator telemetry.prices, making historical reports reproducible. */
  price?: Price;
  cascade?: {
    configHash: string;
    attempts: { metrics: EvalRecord['metrics']; price?: Price }[];
  };
}
const count = { type: 'integer', minimum: 0 };
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const identifier = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$' };
const recordSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'version',
    'runId',
    'project',
    'task',
    'taskHash',
    'bankHash',
    'baseCommit',
    'executor',
    'tier',
    'agentSpecHash',
    'baseline',
    'repetition',
    'status',
    'criteria',
    'durationMs',
    'metrics',
  ],
  properties: {
    version: { const: 1 },
    runId: identifier,
    executionId: identifier,
    project: identifier,
    task: identifier,
    taskHash: hash,
    bankHash: hash,
    baseCommit: { type: 'string', pattern: '^[a-f0-9]{40}$' },
    executor: { enum: ['claude', 'codex'] },
    tier: { enum: ['economy', 'standard', 'deep'] },
    agentSpecHash: hash,
    baseline: { type: 'boolean' },
    repetition: { type: 'integer', minimum: 1 },
    status: {
      enum: ['success', 'criterion_failed', 'criteria_tampered', 'executor_error', 'blocked'],
    },
    criteria: { type: 'array', maxItems: 5, items: { type: 'boolean' } },
    durationMs: count,
    metrics: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        EVAL_METRIC_FIELDS.map((key) => [
          key,
          [
            'softwareagents.executor',
            'gen_ai.request.model',
            'gen_ai.response.model',
            'softwareagents.model.effort',
          ].includes(key)
            ? identifier
            : count,
        ]),
      ),
    },
    price: {
      type: 'object',
      additionalProperties: false,
      required: ['input', 'output'],
      properties: Object.fromEntries(
        ['input', 'output', 'cacheRead', 'cacheCreate'].map((key) => [
          key,
          { type: 'number', minimum: 0 },
        ]),
      ),
    },
    cascade: {
      type: 'object',
      additionalProperties: false,
      required: ['configHash', 'attempts'],
      properties: { configHash: hash, attempts: { type: 'array', maxItems: 3, items: {} } },
    },
  },
};
recordSchema.properties.cascade.properties.attempts.items = {
  type: 'object',
  additionalProperties: false,
  required: ['metrics'],
  properties: { metrics: recordSchema.properties.metrics, price: recordSchema.properties.price },
};
const validate = compileSchema<EvalRecord>(recordSchema);
export const parseEvalRecord = (raw: unknown) => validateSchema(validate, raw);

export function evalResultsDirectory(common: string, project: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project)) throw new Error('Invalid eval Project');
  return resolveInside(common, `softwareagents/evals/${project}`);
}

export async function readEvalRecords(dir: string) {
  const records: EvalRecord[] = [];
  let invalidLines = 0;
  const seen = new Set<string>();
  if (fs.existsSync(dir))
    for (const name of fs
      .readdirSync(dir)
      .filter((n) => /^[a-f0-9-]+\.jsonl$/.test(n))
      .sort()) {
      const input = fs.createReadStream(resolveInside(dir, name));
      for await (const line of createInterface({ input })) {
        try {
          const record = parseEvalRecord(JSON.parse(line));
          const key = `${record.runId}/${record.taskHash}/${record.repetition}`;
          if (seen.has(key)) {
            invalidLines++;
            continue;
          }
          seen.add(key);
          records.push(record);
        } catch {
          invalidLines++;
        }
      }
    }
  return { records, invalidLines };
}

/** Pure aggregation; prices, identity and task revisions travel with each metrics-only row. */
export function buildEvalReport(records: readonly EvalRecord[]) {
  const groups = new Map<string, EvalRecord[]>();
  for (const r of records) {
    const key = JSON.stringify([
      r.bankHash,
      r.cascade?.configHash ?? 'fixed',
      r.cascade ? 'cascade' : r.executor,
      r.cascade ? 'cascade' : r.tier,
      r.cascade ? 'cascade' : (r.metrics['gen_ai.request.model'] ?? 'unknown'),
      r.cascade ? 'cascade' : (r.metrics['softwareagents.model.effort'] ?? 'unknown'),
      r.agentSpecHash,
      r.baseline,
    ]);
    const group = groups.get(key) ?? [];
    group.push(r);
    groups.set(key, group);
  }
  const configurations = [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, rows]) => {
      const first = rows[0];
      const attempted = rows.filter((r) => r.status !== 'blocked');
      const successes = attempted.filter((r) => r.status === 'success').length;
      const totals = emptyTelemetryTotals();
      for (const r of rows) {
        // Include every launched cascade attempt, even if admission blocked a later tier.
        for (const a of r.cascade?.attempts ?? (r.status === 'blocked' ? [] : [r])) {
          const model = a.metrics['gen_ai.response.model'];
          const prices = typeof model === 'string' && a.price ? { [model]: a.price } : undefined;
          addTelemetryTotals(totals, a.metrics, prices);
        }
      }
      const byTask = [...new Set(attempted.map((r) => r.taskHash))].sort().map((hash) => {
        const taskRows = attempted.filter((r) => r.taskHash === hash);
        const outcomes = taskRows.map((r) => r.status === 'success');
        return {
          task: taskRows[0].task,
          taskHash: hash,
          attempts: outcomes.length,
          successRate: outcomes.filter(Boolean).length / outcomes.length,
          consistent:
            outcomes.length > 1
              ? outcomes.every((outcome) => outcome === outcomes[0])
              : ('unknown' as const),
        };
      });
      const repeated = byTask.filter((t) => typeof t.consistent === 'boolean');
      return {
        id,
        bankHash: first.bankHash,
        executor: first.cascade ? 'cascade' : first.executor,
        tier: first.cascade ? 'cascade' : first.tier,
        cascadeConfigHash: first.cascade?.configHash,
        model: first.cascade ? 'cascade' : (first.metrics['gen_ai.request.model'] ?? 'unknown'),
        effort: first.cascade
          ? 'cascade'
          : (first.metrics['softwareagents.model.effort'] ?? 'unknown'),
        agentSpecHash: first.agentSpecHash,
        baseline: first.baseline,
        attempts: attempted.length,
        blocked: rows.length - attempted.length,
        successes,
        successRate: attempted.length ? successes / attempted.length : ('unknown' as const),
        costPerSolvedTaskUsd:
          typeof totals.costUsd === 'number' && successes
            ? totals.costUsd / successes
            : ('unknown' as const),
        totals,
        durationMs: rows.reduce((sum, r) => sum + r.durationMs, 0),
        consistency: repeated.length
          ? repeated.filter((t) => t.consistent === true).length / repeated.length
          : ('unknown' as const),
        byTask,
        pareto: 'unknown' as boolean | 'unknown',
        regressions: [] as {
          task: string;
          baselineRate: number;
          rate: number;
          baselineSpecHash: string;
        }[],
      };
    });
  const coverage = (c: (typeof configurations)[number]) =>
    c.byTask.map((t) => t.taskHash).join(',');
  for (const c of configurations) {
    const cost = c.costPerSolvedTaskUsd;
    const rate = c.successRate;
    if (typeof cost === 'number' && typeof rate === 'number')
      c.pareto = !configurations.some(
        (other) =>
          other.bankHash === c.bankHash &&
          coverage(other) === coverage(c) &&
          typeof other.costPerSolvedTaskUsd === 'number' &&
          typeof other.successRate === 'number' &&
          other.costPerSolvedTaskUsd <= cost &&
          other.successRate >= rate &&
          (other.costPerSolvedTaskUsd < cost || other.successRate > rate),
      );
    if (!c.baseline)
      for (const base of configurations.filter(
        (b) =>
          b.baseline &&
          b.bankHash === c.bankHash &&
          b.executor === c.executor &&
          b.tier === c.tier &&
          b.cascadeConfigHash === c.cascadeConfigHash &&
          b.model === c.model &&
          b.effort === c.effort,
      )) {
        for (const task of c.byTask) {
          const prior = base.byTask.find((t) => t.taskHash === task.taskHash);
          if (prior && task.successRate < prior.successRate)
            c.regressions.push({
              task: task.task,
              baselineRate: prior.successRate,
              rate: task.successRate,
              baselineSpecHash: base.agentSpecHash,
            });
        }
      }
  }
  return {
    version: 1,
    configurations,
    regressionDetected: configurations.some((c) => c.regressions.length > 0),
  };
}
