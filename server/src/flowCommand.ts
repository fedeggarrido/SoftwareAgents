import { CliUsageError } from './cliErrors.js';
import { type FlowEvent, flowMetrics, type FlowTask, wipSnapshot } from './flow.js';
import { loadProjectConfig } from './projectConfig.js';
import { openReadOnlyWorkStore, readMainAncestors } from './workstore/readOnlyWorkStore.js';

export async function runFlowCommand(argv: string[], cwd = process.cwd(), log = console.log) {
  let feature: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json' && !json) json = true;
    else if (argv[i] === '--feature' && !feature && /^FEAT-\d{3,}$/.test(argv[i + 1] ?? ''))
      feature = argv[++i];
    else throw new CliUsageError('Usage: pixel-agents flow [--feature KEY] [--json]');
  }
  const config = loadProjectConfig(cwd, true);
  if (!config) throw new CliUsageError('flow requires a bound Project');
  const db = openReadOnlyWorkStore(config.repoRoot);
  try {
    db.exec('BEGIN');
    const tasks = db
      .prepare('SELECT key, status, feature_key, declaration FROM tasks WHERE project_id = ?')
      .all(config.project.id) as unknown as FlowTask[];
    const events = db
      .prepare(
        'SELECT task_key, from_status, to_status, created_at FROM domain_events WHERE project_id = ? ORDER BY id',
      )
      .all(config.project.id) as unknown as FlowEvent[];
    const runs = db
      .prepare('SELECT feature_key, state FROM feature_runs WHERE project_id = ?')
      .all(config.project.id);
    const ancestors = readMainAncestors(config.repoRoot);
    const ready = new Set(
      runs
        .filter((r) => {
          const state = JSON.parse(r.state as string);
          return state.status === 'ready_to_merge' && !ancestors.has(state.head);
        })
        .map((r) => String(r.feature_key)),
    );
    const summary = {
      wip: wipSnapshot(tasks, ready, config.operator.wip),
      ...flowMetrics(
        // Flow is measured on DAG work only, like WIP; spec/design documents never flow.
        tasks.filter((t) => !!t.declaration && (!feature || t.feature_key === feature)),
        events,
        Date.now(),
        ready,
      ),
    };
    log(
      json
        ? JSON.stringify(summary, null, 2)
        : [
            flowLabel(summary.wip, summary),
            `Running: ${summary.wip.running.tasks.join(', ') || 'none'}`,
            `Review: ${summary.wip.review.tasks.join(', ') || 'none'}`,
            'Throughput DONE/day (UTC): ' +
              (Object.entries(summary.throughput)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([day, n]) => `${day}: ${n}`)
                .join(', ') || 'none'),
            `Metrics without recorded transitions: ${summary.unknown.length} (see --json)`,
          ].join('\n'),
    );
  } finally {
    db.close();
  }
}

const FLOW_METRIC_LABELS = {
  cycle: 'cycle',
  wipAge: 'WIP age',
  reviewWait: 'review wait',
} as const;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Durations for people: minutes under an hour, hours under two days, then days. */
export function humanDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'unknown';
  if (ms < HOUR_MS) return `${Math.max(1, Math.round(ms / MINUTE_MS))} min`;
  if (ms < 2 * DAY_MS) return `${(ms / HOUR_MS).toFixed(1)} h`;
  return `${(ms / DAY_MS).toFixed(1)} d`;
}

export function flowLabel(
  wip: ReturnType<typeof wipSnapshot>,
  metrics: ReturnType<typeof flowMetrics>,
): string {
  const days = Object.entries(metrics.throughput).sort(([a], [b]) => a.localeCompare(b));
  const latest = days.at(-1);
  return (
    `WIP running ${wip.running.tasks.length}/${wip.running.limit ?? 'unlimited'}; review ${wip.review.tasks.length}/${wip.review.limit ?? 'unlimited'}; ` +
    (['cycle', 'wipAge', 'reviewWait'] as const)
      .map(
        (key) =>
          `${FLOW_METRIC_LABELS[key]} median ${humanDuration(metrics[key].medianMs)}, p85 ${humanDuration(metrics[key].p85Ms)} (n=${metrics[key].n})`,
      )
      .join('; ') +
    `; DONE/day UTC ${latest ? `${latest[0]}: ${latest[1]}` : 'unknown'}`
  );
}
