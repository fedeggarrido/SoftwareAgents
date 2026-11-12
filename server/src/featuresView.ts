import type { DatabaseSync } from 'node:sqlite';

import type {
  FeatureGate,
  FeatureRow,
  FeaturesReadError,
  FeatureTaskStep,
} from '../../core/src/messages.js';
import type { ProjectOperatorConfig } from '../../core/src/project.js';
import { readConfig } from './configPersistence.js';
import { featureMerged } from './featureCompletion.js';
import { type FlowEvent, flowMetrics, type FlowTask, wipSnapshot } from './flow.js';
import { flowLabel } from './flowCommand.js';
import { aggregateUsage, type UsageEntry } from './usageLedger.js';
import {
  FeaturesReadFailure,
  openReadOnlyWorkStore,
  readMainAncestors,
} from './workstore/readOnlyWorkStore.js';
import { monitoredZones, type ZonesReport } from './zonesCheck.js';

type Row = Record<string, unknown>;
export interface FeaturesSource {
  wip?: ProjectOperatorConfig['wip'];
  features: Row[];
  designs: Row[];
  tasks: Row[];
  runs: Row[];
  decisions: Row[];
  executions: Row[];
  events: Row[];
  ledger?: Row[];
  mainAncestors?: ReadonlySet<string>;
  zones?: ZonesReport;
}
export interface FeaturesViewResult {
  status: 'ok' | 'empty' | 'read_error';
  reason: FeaturesReadError | null;
  features: FeatureRow[];
}
function invalid(): never {
  throw new FeaturesReadFailure('invalid_data');
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : invalid();
}
function optional(value: unknown): string | null {
  return absent(value) ? null : text(value);
}
function absent(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}
function object(value: unknown): Row {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return invalid();
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : invalid();
}
function timestamp(value: unknown): string | null {
  const s = optional(value);
  if (s === null || s === '') return null;
  if (!Number.isFinite(Date.parse(s))) return invalid();
  return new Date(s).toISOString();
}
function step(value: unknown): FeatureTaskStep | null {
  return value === 'develop' || value === 'review' || value === 'qa' ? value : null;
}
// Free display text is never interpreted as markup. Remove controls and redact
// common credential/path forms before it crosses the webview boundary.
// Slash-prefixed title fragments are also redacted: confidentiality takes
// precedence over preserving ambiguous path-like display text.
function display(value: unknown): string | null {
  return (
    optional(value)
      ?.replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/(?:https?:\/\/|[a-z]:[\\/]|(?<![<\w])\/)[^\s<>]+/gi, '[redacted]')
      .replace(/(?:sk-|ghp_|github_pat_)[a-z0-9_-]+/gi, '[redacted]') ?? null
  );
}

export { display as featureDisplayText };

/** Pure projection: only explicitly named display fields can escape. */
export function projectFeatures(source: FeaturesSource): FeatureRow[] {
  const entries = (source.ledger ?? []).map(featureUsageEntry);
  const ready = new Set(
    source.runs
      .filter((row) => {
        const run = object(row.state);
        return run.status === 'ready_to_merge' && !source.mainAncestors?.has(String(run.head));
      })
      .map((row) => text(row.feature_key)),
  );
  const wip = wipSnapshot(source.tasks as unknown as FlowTask[], ready, source.wip);
  return source.features
    .map((feature): FeatureRow => {
      const key = text(feature.key);
      if (!/^FEAT-\d{3}$/.test(key)) return invalid();
      const status = text(feature.status);
      const tasks = source.tasks.filter((t) => t.feature_key === key);
      for (const task of tasks) {
        text(task.key);
        if (!absent(task.status)) text(task.status);
        if (!absent(task.version) && (!Number.isInteger(task.version) || Number(task.version) < 1))
          invalid();
      }
      const taskKeys = new Set(tasks.map((t) => text(t.key)));
      const usage = aggregateUsage(
        entries.filter((entry) => entry.featureKey === key),
        tasks.map((task) => ({
          key: text(task.key),
          status: task.status === 'DONE' ? 'DONE' : 'DRAFT',
        })),
      );
      for (const taskKey of taskKeys)
        if (
          taskKey !== key &&
          !new RegExp(`^${key}-(?:T\\d{2}(?:-D\\d+)?|DESIGN|REQUIREMENTS)$`).test(taskKey)
        )
          return invalid();
      const dag = tasks.filter(
        (t) => !absent(t.declaration) && new RegExp(`^${key}-T\\d{2}$`).test(text(t.key)),
      );
      const runRow = source.runs.find((r) => r.feature_key === key);
      const run = runRow ? object(runRow.state) : null;
      if (run) {
        for (const field of ['status', 'branch', 'head', 'message']) optional(run[field]);
      }
      const merged = featureMerged(key, dag, run, source.mainAncestors);
      const belongs = (value: unknown) =>
        typeof value === 'string' &&
        (value === key || value === `${key}-DESIGN` || taskKeys.has(value));
      const related: (Row & { data: Row | null })[] = [];
      for (const decision of source.decisions) {
        let data: Row | null = null;
        try {
          data = absent(decision.escalation) ? null : object(decision.escalation);
        } catch (error) {
          if (belongs(decision.task_key)) throw error;
          continue;
        }
        const blocks = data?.blocks;
        if (!belongs(decision.task_key) && !(Array.isArray(blocks) && blocks.some(belongs)))
          continue;
        if (data && (!Array.isArray(blocks) || !blocks.every((v) => typeof v === 'string')))
          return invalid();
        related.push({ ...decision, data });
      }
      const gates: FeatureGate[] = [];
      if (run?.wipWait) {
        const waiting = object(run.wipWait);
        gates.push({
          kind: 'waiting_human',
          task: text(waiting.task),
          expired: false,
          command: 'pixel-agents flow',
          reason: display(waiting.reason) ?? '',
        });
      }
      const gate = (
        kind: FeatureGate['kind'],
        task: string | null,
        command: string,
        expired = false,
      ) => gates.push({ kind, task, expired, command: `pixel-agents feature ${command}` });
      const covered = new Set<string>();
      if (run?.zoneWait) {
        const waiting = object(run.zoneWait);
        gates.push({
          kind: 'zone_overlap',
          task: text(waiting.task),
          expired: false,
          command: 'pixel-agents zones check',
          reason: display(waiting.reason) ?? '',
        });
      }
      for (const task of tasks) {
        const branches = [
          optional(task.branch),
          `sa/${text(task.key)}-developer`,
          `sa/${key}-integration`,
        ];
        const warnings =
          source.zones?.overlaps.filter((overlap) =>
            overlap.branches.some((branch) => branches.includes(branch)),
          ) ?? [];
        const outside =
          source.zones?.branches
            .filter((branch) => branches.includes(branch.branch))
            .flatMap((branch) => branch.outsideZones) ?? [];
        if (warnings.length || outside.length)
          gates.push({
            kind: 'zone_overlap',
            task: text(task.key),
            expired: false,
            command: 'pixel-agents zones check',
            reason:
              display(
                [
                  ...warnings.map((warning) => `${warning.file}: ${warning.branches.join(', ')}`),
                  ...outside.map((file) => `outside declared zones: ${file}`),
                ].join('; '),
              ) ?? '',
          });
      }
      for (const decision of related) {
        const d = decision.data;
        if (!d) continue;
        if (!['open', 'answered', 'expired'].includes(text(d.status))) return invalid();
        if (d.status === 'answered') continue;
        const context = text(d.context);
        const task =
          !absent(decision.task_key) && taskKeys.has(text(decision.task_key))
            ? text(decision.task_key)
            : ((d.blocks as string[]).find((block) => taskKeys.has(block)) ?? null);
        for (const block of d.blocks as string[]) if (taskKeys.has(block)) covered.add(block);
        if (task) covered.add(task);
        const kind = context.startsWith(`feature-requirements/${key}/`)
          ? 'requirements_questions'
          : context.startsWith(`feature-design/${key}-DESIGN/`)
            ? 'design_questions'
            : 'human_decision';
        gate(
          kind,
          task,
          kind === 'requirements_questions'
            ? `spec ${key} --answers <fichero-de-respuestas>`
            : kind === 'design_questions'
              ? `design ${key} --answers <fichero-de-respuestas>`
              : `show ${key}`,
          d.status === 'expired',
        );
      }
      if (status === 'in_review' && !gates.some((g) => g.kind === 'requirements_questions'))
        gate('spec_approval', null, `approve ${key}`);
      for (const task of tasks) {
        if (task.status === 'WAITING_QUOTA') gate('quota', text(task.key), `run ${key}`);
        if (task.status === 'WAITING_HUMAN' && !covered.has(text(task.key)))
          gate('waiting_human', text(task.key), `show ${key}`);
      }
      if (run?.status === 'WAITING_QUOTA' && !gates.some((g) => g.kind === 'quota'))
        gate('quota', null, `run ${key}`);
      if (run?.status === 'WAITING_HUMAN' && optional(run.message)?.startsWith('QA not_tested'))
        gate('qa_not_tested', null, `run ${key}`);
      const activeTasks = tasks
        .filter((t) => t.status === 'LEASED' || t.status === 'RUNNING')
        .sort(
          (a, b) =>
            (timestamp(b.updated_at) ?? '').localeCompare(timestamp(a.updated_at) ?? '') ||
            text(a.key).localeCompare(text(b.key)),
        );
      let currentTask: FeatureRow['currentTask'] = null;
      if (!absent(run?.active)) {
        const active = object(run.active);
        text(active.action);
        if (taskKeys.has(text(active.task)))
          currentTask = {
            key: text(active.task),
            step: step(active.action),
            others: activeTasks.filter((t) => t.key !== active.task).length,
          };
      }
      if (!currentTask && activeTasks.length) {
        const task = activeTasks[0];
        const executions = source.executions
          .filter((e) => e.task_key === task.key && e.task_version === task.version)
          .sort((a, b) =>
            (timestamp(b.started_at) ?? '').localeCompare(timestamp(a.started_at) ?? ''),
          );
        const role = executions[0]?.agent_role;
        currentTask = {
          key: text(task.key),
          step:
            role === 'developer'
              ? 'develop'
              : role === 'reviewer'
                ? 'review'
                : role === 'qa'
                  ? 'qa'
                  : absent(task.review_ref)
                    ? 'develop'
                    : null,
          others: activeTasks.length - 1,
        };
      }
      const times = [
        feature.updated_at,
        runRow?.updated_at,
        ...tasks.map((t) => t.updated_at),
        ...related.map((d) => d.decided_at),
        ...source.events.filter((e) => taskKeys.has(text(e.task_key))).map((e) => e.created_at),
      ]
        .map(timestamp)
        .filter((s): s is string => s !== null)
        .sort();
      return {
        key,
        flow: flowLabel(
          wip,
          flowMetrics(
            (tasks as unknown as FlowTask[]).filter((t) => !!t.declaration),
            source.events as unknown as FlowEvent[],
            Date.now(),
          ),
        ),
        cost: {
          executions: usage.executions,
          costKnown: usage.costCoverage,
          costUsd: finite(usage.costUsd),
          costPerDoneTaskUsd: finite(usage.costPerResolvedTaskUsd),
          cacheHitRate: finite(usage.cacheHitRate),
        },
        title: display(feature.title),
        state: merged
          ? 'merged'
          : status === 'ready_to_merge'
            ? 'ready_to_merge'
            : status === 'in_review'
              ? 'in_review'
              : status === 'approved'
                ? source.designs.some((d) => d.feature_key === key)
                  ? 'in_development'
                  : 'in_design'
                : 'unknown',
        rawStatus: ['ready_to_merge', 'in_review', 'approved'].includes(status)
          ? null
          : display(status),
        progress: dag.length
          ? { done: dag.filter((t) => t.status === 'DONE').length, total: dag.length }
          : null,
        currentTask,
        gates,
        integration:
          run && run.branch === `sa/${key}-integration`
            ? {
                branch: text(run.branch),
                sha:
                  typeof run.head === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(run.head)
                    ? run.head.slice(0, 7)
                    : null,
              }
            : null,
        lastActivityAt: times.at(-1) ?? null,
      };
    })
    .sort(
      (a, b) =>
        (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') ||
        a.key.localeCompare(b.key),
    );
}

export async function readFeaturesView(
  root: string,
  projectId: string,
): Promise<FeaturesViewResult> {
  let db: ReturnType<typeof openReadOnlyWorkStore> | undefined;
  try {
    if (typeof projectId !== 'string' || !projectId) return invalid();
    db = openReadOnlyWorkStore(root);
    db.exec('BEGIN');
    const features = projectFeatures(await readFeaturesSource(db, root, projectId));
    return { status: features.length ? 'ok' : 'empty', reason: null, features };
  } catch (error) {
    return {
      status: 'read_error',
      reason: error instanceof FeaturesReadFailure ? error.reason : 'query_failed',
      features: [],
    };
  } finally {
    db?.close();
  }
}

/** Shared input reader. The caller owns the read-only transaction. */
export async function readFeaturesSource(
  db: DatabaseSync,
  root: string,
  projectId: string,
): Promise<FeaturesSource> {
  const read = (table: string, columns: string) =>
    db.prepare(`SELECT ${columns} FROM ${table} WHERE project_id = ?`).all(projectId);
  const zoneTasks = read('tasks', 'key, branch, feature_key, declaration').map((row) => ({
    key: text(row.key),
    branch: optional(row.branch),
    feature_key: optional(row.feature_key),
    declaration: optional(row.declaration),
  }));
  const zones = await monitoredZones(root, zoneTasks);
  return {
    wip: readConfig().projects[projectId]?.wip,
    zones,
    features: read('features', 'key, title, status, updated_at'),
    designs: read('technical_designs', 'feature_key'),
    tasks: read(
      'tasks',
      'key, branch, feature_key, status, declaration, version, review_ref, priority, blocked_reason, updated_at',
    ),
    runs: read('feature_runs', 'feature_key, state, updated_at'),
    decisions: read('human_decisions', 'key, task_key, escalation, decided_at'),
    executions: read('executions', 'task_key, agent_role, task_version, started_at'),
    events: read('domain_events', 'task_key, from_status, to_status, created_at'),
    ledger: db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_ledger'")
      .get()
      ? read('usage_ledger', 'body')
      : [],
    mainAncestors: readMainAncestors(root),
  };
}

function finite(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

export function featureUsageEntry(row: Row): UsageEntry {
  if (typeof row.body !== 'string') return invalid();
  const body = object(row.body);
  const counter = (field: string): number | null => {
    const value = body[field];
    return value === null
      ? null
      : typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : invalid();
  };
  const featureKey = body.featureKey === null ? null : text(body.featureKey);
  // Discard all unrelated payload fields; aggregation receives only validated counters.
  return {
    featureKey,
    taskKey: optional(body.taskKey) ?? '',
    costUsd: counter('costUsd'),
    inputTokens: counter('inputTokens'),
    cacheReadTokens: counter('cacheReadTokens'),
    executionId: '',
    day: '',
    startedAt: '',
    endedAt: null,
    durationMs: null,
    attempt: null,
    executor: '',
    model: '',
    tier: null,
    outputTokens: absent(body.outputTokens) ? null : counter('outputTokens'),
    cacheCreateTokens: null,
    cacheHitRate: null,
    quotaBefore: null,
    quotaAfter: null,
  };
}
