import * as fs from 'node:fs';

import { AuditLog } from './auditLog.js';
import { gitCommonDir } from './boardWatcher.js';
import { CliUsageError } from './cliErrors.js';
import { backup } from './commands/task.js';
import { TASK_CLI_DEFAULT_KEEP } from './constants.js';
import { featureIngressActor } from './featureIngress.js';
import { resolveInside } from './pathGuard.js';
import { loadProjectConfig } from './projectConfig.js';
import { telemetryDirectory, type TelemetrySpan } from './telemetry.js';
import { telemetryAttributes } from './telemetryCommand.js';
import { type UsageEntry, usageEntry } from './usageLedger.js';
import { openReadOnlyWorkStore } from './workstore/readOnlyWorkStore.js';
import { openWorkStore } from './workstore/SqliteWorkStore.js';
import type { ExecutionRecord, TaskRecord } from './workstore/WorkStore.js';

/** Malformed/truncated lines are not evidence. Missing retained files are normal. */
function lines(file: string): unknown[] {
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return body.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

export async function runUsageBackfill(argv: string[], cwd: string, log: (s: string) => void) {
  if (new Set(argv).size !== argv.length || argv.some((a) => !['--dry-run', '--json'].includes(a)))
    throw new CliUsageError('Usage: pixel-agents usage backfill [--dry-run] [--json]');
  if (featureIngressActor() !== 'human')
    throw new CliUsageError('usage backfill requires human ingress (SA-003)');
  const config = loadProjectConfig(cwd, true);
  const common = gitCommonDir(cwd);
  if (!config || !common) throw new CliUsageError('usage backfill requires a bound Git Project');
  const db = openReadOnlyWorkStore(config.repoRoot);
  const entries: UsageEntry[] = [];
  let skipped = 0;
  try {
    db.exec('BEGIN');
    const executions = db
      .prepare('SELECT * FROM executions WHERE project_id = ? ORDER BY started_at, key')
      .all(config.project.id) as unknown as ExecutionRecord[];
    const tasks = db
      .prepare('SELECT * FROM tasks WHERE project_id = ?')
      .all(config.project.id) as unknown as TaskRecord[];
    const existing = new Set(
      db
        .prepare('SELECT execution_key FROM usage_ledger WHERE project_id = ?')
        .all(config.project.id)
        .map((r) => r.execution_key),
    );
    const retained = new Map<string, Record<string, string | number>>();
    const retainedEnd = new Map<string, string>();
    const dir = telemetryDirectory(common, config.project.id);
    for (const name of fs.existsSync(dir) ? ['spans.1.jsonl', 'spans.jsonl'] : []) {
      for (const record of lines(resolveInside(dir, name))) {
        try {
          const envelope = record as {
            resourceSpans: { scopeSpans: { spans: TelemetrySpan[] }[] }[];
          };
          for (const resource of envelope.resourceSpans)
            for (const scope of resource.scopeSpans)
              for (const span of scope.spans) {
                if (span.name !== 'invoke_agent') continue;
                const attrs = telemetryAttributes(span);
                const key = attrs['softwareagents.execution.id'];
                if (typeof key === 'string') {
                  retained.set(key, attrs);
                  const end = Number(span.endTimeUnixNano) / 1_000_000;
                  if (
                    Number.isFinite(end) &&
                    end >= Date.parse(executions.find((e) => e.key === key)?.started_at ?? '')
                  )
                    retainedEnd.set(key, new Date(end).toISOString());
                }
              }
        } catch {
          /* Not a valid root span. */
        }
      }
    }
    for (const execution of executions) {
      if (existing.has(execution.key)) continue;
      const task = tasks.find((t) => t.key === execution.task_key);
      if (!task || (execution.pid !== null && !execution.tree_closed_at)) {
        skipped++;
        continue;
      }
      const attrs: Record<string, string | number> = {
        'softwareagents.executor': execution.executor,
      };
      let finished = false;
      let endedAt = execution.tree_closed_at ?? null;
      for (const record of lines(
        resolveInside(common, `softwareagents/runs/${execution.key}.jsonl`),
      )) {
        if (!record || typeof record !== 'object') continue;
        const event = record as {
          type?: string;
          endedAt?: string;
          observation?: {
            kind?: string;
            model?: string;
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheCreate?: number;
          };
        };
        if (event.type === 'finished') {
          finished = true;
          if (
            !endedAt &&
            typeof event.endedAt === 'string' &&
            Number.isFinite(Date.parse(event.endedAt))
          )
            endedAt = event.endedAt;
        }
        const o = event.type === 'telemetry' ? event.observation : undefined;
        if (o?.kind === 'model' && typeof o.model === 'string') {
          if (attrs['gen_ai.response.model'] && attrs['gen_ai.response.model'] !== o.model)
            attrs['softwareagents.model.multiple'] = 1;
          attrs['gen_ai.response.model'] = o.model;
        }
        if (o?.kind === 'usage')
          for (const [key, value] of Object.entries({
            input_tokens: o.input,
            output_tokens: o.output,
            'cache_read.input_tokens': o.cacheRead,
            'cache_creation.input_tokens': o.cacheCreate,
          })) {
            if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
              attrs[`gen_ai.usage.${key}`] = value;
          }
      }
      endedAt ??= retainedEnd.get(execution.key) ?? null;
      if (!finished && !execution.tree_closed_at && !retainedEnd.has(execution.key)) {
        skipped++;
        continue;
      }
      // Root spans supplement missing counters; never sum the same execution twice.
      for (const [key, value] of Object.entries(retained.get(execution.key) ?? {}))
        attrs[key] ??= value;
      const entry = usageEntry(
        execution,
        task,
        attrs,
        config.operator.telemetry?.prices,
        endedAt ?? execution.started_at,
      );
      entries.push({
        ...entry,
        source: 'backfill',
        attempt: null,
        endedAt,
        durationMs: endedAt ? entry.durationMs : null,
      });
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  let destination: string | null = null;
  if (!argv.includes('--dry-run')) {
    const store = await openWorkStore({
      repositoryPath: config.repoRoot,
      projectId: config.project.id,
    });
    const audit = (status: string) =>
      new AuditLog().append({
        projectId: config.project.id,
        actorType: 'human',
        actorId: 'operator',
        action: 'usage_backfill',
        resourceType: 'project',
        resourceId: config.project.id,
        policyDecision: null,
        riskLevel: 'medium',
        taskKey: null,
        executionId: null,
        outcome: { status },
        input: { executions: entries.map((e) => e.executionId), backup: destination },
      });
    try {
      destination = await backup(store, TASK_CLI_DEFAULT_KEEP);
      audit('intent');
      for (const entry of entries) await store.recordUsage(entry);
      audit('committed');
    } finally {
      store.close();
    }
  }
  const result = { dryRun: argv.includes('--dry-run'), backup: destination, entries, skipped };
  log(
    argv.includes('--json')
      ? JSON.stringify(result, null, 2)
      : `${result.dryRun ? 'Would backfill' : 'Backfilled'}: ${entries.length}; skipped: ${skipped}; backup: ${destination ?? 'none'}`,
  );
}
