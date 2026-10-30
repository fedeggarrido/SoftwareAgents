import { CliUsageError } from '../cliErrors.js';
import { featureIngressActor } from '../featureIngress.js';
import { findingPrecision } from '../findingPrecision.js';
import { loadProjectConfig } from '../projectConfig.js';
import { openWorkStore } from '../workstore/SqliteWorkStore.js';

const USAGE =
  'Usage: pixel-agents review finding <TASK> <index> --accept|--reject [--reason <text>] | precision [--feature <KEY>] [--json]';

export async function runReviewCommand(argv: string[], cwd = process.cwd(), log = console.log) {
  const [command, ...args] = argv;
  let feature: string | undefined;
  let json = false;
  if (command === 'precision') {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--json' && !json) json = true;
      else if (args[i] === '--feature' && !feature && /^FEAT-\d{3,}$/.test(args[i + 1] ?? ''))
        feature = args[++i];
      else throw new CliUsageError(USAGE);
    }
  } else if (command === 'finding') {
    if (featureIngressActor() !== 'human')
      throw new CliUsageError('review finding requires human ingress (SA-003)');
    if (
      !/^[0-9]+$/.test(args[1] ?? '') ||
      !Number.isSafeInteger(Number(args[1])) ||
      !['--accept', '--reject'].includes(args[2]) ||
      !(args.length === 3 || (args.length === 5 && args[3] === '--reason' && args[4].trim()))
    )
      throw new CliUsageError(USAGE);
  } else throw new CliUsageError(USAGE);
  const config = loadProjectConfig(cwd, true);
  if (!config) throw new CliUsageError('review requires a bound Project');
  const store = await openWorkStore({
    repositoryPath: config.repoRoot,
    projectId: config.project.id,
  });
  try {
    if (command === 'precision') {
      const summary = findingPrecision(
        store.listFindingDecisions().filter((row) => !feature || row.feature === feature),
      );
      log(
        json
          ? JSON.stringify(summary, null, 2)
          : summary.groups
              .map(
                (row) =>
                  `${row.role} ${row.executor}/${row.model} ${row.severity}: ${row.acceptanceRate * 100}% (n=${row.n})`,
              )
              .join('\n') +
              '\nDowngraded: ' +
              JSON.stringify(summary.downgraded),
      );
      return;
    }
    const task = store.getTask(args[0]);
    // Latest persisted verifier execution; indexes are zero based within that report.
    const reports = [...(task?.review_reports ?? []), ...(task?.test_reports ?? [])];
    const executions = store
      .listExecutions()
      .filter((row) => reports.some((report) => report.execution_id === row.key))
      .sort((a, b) => a.started_at.localeCompare(b.started_at) || a.task_version - b.task_version);
    const execution = executions.at(-1);
    if (!task || !execution) throw new CliUsageError('Task has no persisted verifier report');
    await store.recordFindingDecision({
      task: task.key,
      feature: task.feature_key,
      execution: execution.key,
      index: Number(args[1]),
      role: '',
      executor: '',
      model: '',
      severity: '',
      downgradeReasons: [],
      decision: args[2] === '--accept' ? 'accept' : 'reject',
      reason: args[4]?.trim(),
      actor: 'human',
      decidedAt: new Date().toISOString(),
    });
    log('Finding decision recorded');
  } finally {
    store.close();
  }
}
