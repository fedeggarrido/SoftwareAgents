import { CliUsageError } from './cliErrors.js';
import { loadProjectConfig } from './projectConfig.js';
import { runUsageBackfill } from './usageBackfill.js';
import { type UsageEntry, usageSummary } from './usageLedger.js';
import type { TaskRecord } from './workstore/WorkStore.js';

/** No migration, probes or writes: an older database requires an explicit writer upgrade. */
export async function runUsageCommand(argv: string[], cwd = process.cwd(), log = console.log) {
  if (argv[0] === 'backfill') return runUsageBackfill(argv.slice(1), cwd, log);
  let feature: string | undefined;
  let day: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json' && !json) json = true;
    else if (argv[i] === '--feature' && !feature && /^FEAT-\d{3,}$/.test(argv[i + 1] ?? ''))
      feature = argv[++i];
    else if (
      argv[i] === '--day' &&
      !day &&
      /^\d{4}-\d{2}-\d{2}$/.test(argv[i + 1] ?? '') &&
      Number.isFinite(Date.parse(argv[i + 1])) &&
      new Date(argv[i + 1]).toISOString().slice(0, 10) === argv[i + 1]
    )
      day = argv[++i];
    else
      throw new CliUsageError(
        'Usage: pixel-agents usage [--feature F] [--day YYYY-MM-DD] [--json]',
      );
  }
  const config = loadProjectConfig(cwd, true);
  if (!config) throw new CliUsageError('usage requires a bound Project');
  const { openReadOnlyWorkStore } = await import('./workstore/readOnlyWorkStore.js');
  const db = openReadOnlyWorkStore(config.repoRoot);
  try {
    const ledger = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_ledger'")
      .get();
    if (!ledger)
      throw new CliUsageError(
        'usage: the WorkStore predates the usage ledger (schema v16); run any writing command, e.g. `pixel-agents task list`, to migrate it first',
      );
    db.exec('BEGIN');
    const entries = db
      .prepare('SELECT body FROM usage_ledger WHERE project_id = ?')
      .all(config.project.id)
      .map((row) => JSON.parse(row.body as string) as UsageEntry);
    const tasks = db
      .prepare('SELECT key, status, feature_key FROM tasks WHERE project_id = ?')
      .all(config.project.id) as unknown as TaskRecord[];
    const summary = usageSummary(entries, tasks, { feature, day });
    db.exec('COMMIT');
    log(
      json
        ? JSON.stringify(summary, null, 2)
        : `Executions: ${summary.total.executions}\nEstimated API-equivalent cost USD (CLI-reported tokens x configured prices; not a charge): ${summary.total.costUsd ?? 'unknown'} (known for ${summary.total.costCoverage}/${summary.total.executions})\nEstimated cost per DONE task USD: ${summary.total.costPerResolvedTaskUsd ?? 'unknown'}\nCache hit rate: ${summary.total.cacheHitRate ?? 'unknown'} (tokens known for ${summary.total.tokenCoverage}/${summary.total.executions})` +
            Object.entries(summary.byRole)
              .map(
                ([role, totals]) =>
                  `\nRole ${role}: cache hit rate ${totals.cacheHitRate ?? 'unknown'}; distinct prefixHash ${totals.distinctPrefixHashes}; unknown prefix executions ${totals.unknownPrefixExecutions}`,
              )
              .join(''),
    );
  } finally {
    db.close();
  }
}
