import { createInterface } from 'node:readline/promises';

import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { ModelTier } from '../../core/src/modelTier.js';
import { compileAgent } from './agentCompiler.js';
import { gitCommonDir } from './boardWatcher.js';
import { CliUsageError } from './cliErrors.js';
import { EVAL_MAX_REPETITIONS } from './constants.js';
import { checkEvalCriteria, EvalCriterionTerminationError } from './evalCriteria.js';
import { assertEvalRunAllowed } from './evalGuard.js';
import { assertEvalIntegrity } from './evalIntegrity.js';
import {
  buildEvalReport,
  EVAL_METRIC_FIELDS,
  type EvalRecord,
  evalResultsDirectory,
  parseEvalRecord,
  readEvalRecords,
} from './evalReport.js';
import { loadEvalTasks } from './evalTasks.js';
import { createEvalWorktree } from './evalWorktree.js';
import { MODEL_TIERS } from './modelTiers.js';
import { resolveInside } from './pathGuard.js';
import { loadProjectConfig } from './projectConfig.js';
import { telemetryAttributes } from './telemetryCommand.js';
import { loadWorkerAgentSpec, runWorker, type WorkerOptions } from './worker.js';

export interface EvalArgs {
  command: 'list' | 'validate' | 'report' | 'run';
  json: boolean;
  yes: boolean;
  task?: string;
  executor?: 'claude' | 'codex';
  tier?: ModelTier;
  repeat?: number;
  agentSpec?: string;
}
export function parseEvalArgs(argv: string[]): EvalArgs {
  const [command] = argv;
  if (!['list', 'validate', 'report', 'run'].includes(command))
    throw new CliUsageError('Usage: pixel-agents eval list|validate|report|run [options]');
  const result: EvalArgs = { command: command as EvalArgs['command'], json: false, yes: false };
  const values: Record<string, string> = {};
  const seen = new Set<string>();
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw new CliUsageError('Duplicate eval option');
    seen.add(flag);
    if (flag === '--json') result.json = true;
    else if (flag === '--yes' && command === 'run') result.yes = true;
    else if (
      command === 'run' &&
      ['--task', '--executor', '--tier', '--repeat', '--agent-spec'].includes(flag) &&
      argv[i + 1] &&
      !argv[i + 1].startsWith('--')
    )
      values[flag] = argv[++i];
    else throw new CliUsageError(`Unknown or incomplete eval option: ${flag}`);
  }
  if (command === 'run') {
    if (
      !/^(all|[a-z][a-z0-9-]{0,63})$/.test(values['--task'] ?? '') ||
      !['claude', 'codex'].includes(values['--executor']) ||
      !MODEL_TIERS.includes(values['--tier'] as ModelTier) ||
      !/^[1-9]\d*$/.test(values['--repeat'] ?? '') ||
      Number(values['--repeat']) > EVAL_MAX_REPETITIONS
    )
      throw new CliUsageError(
        `eval run requires --task <id|all> --executor claude|codex --tier economy|standard|deep --repeat 1..${EVAL_MAX_REPETITIONS}`,
      );
    Object.assign(result, {
      task: values['--task'],
      executor: values['--executor'],
      tier: values['--tier'],
      repeat: Number(values['--repeat']),
      agentSpec: values['--agent-spec'],
    });
  }
  return result;
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface EvalCommandOptions {
  cwd?: string;
  log?: (message: string) => void;
  /** Test-only protocol prefixes/probes. The CLI never accepts an executable from the repo. */
  worker?: Pick<WorkerOptions, 'binaryArgs' | 'probe'>;
  confirm?: (executions: number) => Promise<boolean>;
}

async function confirmRun(executions: number): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new CliUsageError(
      `eval run will launch ${executions} executions; use --yes or an interactive terminal`,
    );
  const input = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test(
      (
        await input.question(
          `Launch ${executions} model executions, consuming account quota? [y/N] `,
        )
      ).trim(),
    );
  } finally {
    input.close();
  }
}

export async function runEvalCommand(
  argv: string[],
  options: EvalCommandOptions = {},
): Promise<void> {
  const args = parseEvalArgs(argv);
  // Before reading the bank, probing binaries, prompting or creating any files.
  if (args.command === 'run') assertEvalRunAllowed();
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? console.log;
  if (args.command === 'list' || args.command === 'validate') {
    const tasks = loadEvalTasks(cwd);
    log(
      args.json
        ? JSON.stringify({ valid: true, tasks }, null, 2)
        : args.command === 'validate'
          ? `${tasks.length} valid eval tasks`
          : tasks.map((t) => `${t.id} (${t.timeoutMin} min): ${t.brief}`).join('\n'),
    );
    return;
  }
  const config = loadProjectConfig(cwd, args.command === 'run');
  const common = gitCommonDir(cwd);
  if (!config || !common) throw new CliUsageError('eval requires a bound Git Project');
  const directory = evalResultsDirectory(common, config.project.id);
  if (args.command === 'report') {
    const { records, invalidLines } = await readEvalRecords(directory);
    const report = { ...buildEvalReport(records), invalidLines };
    log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
    return;
  }
  const bank = loadEvalTasks(cwd);
  const tasks = args.task === 'all' ? bank : bank.filter((t) => t.id === args.task);
  if (!tasks.length) throw new CliUsageError(`Unknown eval task: ${args.task}`);
  const executor = args.executor!;
  const tier = args.tier!;
  const policy = config.operator.modelTiers;
  if (
    !config.operator.allowedExecutors.includes(executor) ||
    !policy ||
    MODEL_TIERS.indexOf(tier) > MODEL_TIERS.indexOf(policy.maxTier) ||
    !policy.tiers[tier]?.candidates.some((c) => c.executor === executor) ||
    !(config.operator.executorLevels?.[executor]?.includes(tier) ?? true)
  )
    throw new CliUsageError('Requested eval executor/tier is not allowed by Operator config');
  const spec = loadWorkerAgentSpec(args.agentSpec ? path.resolve(cwd, args.agentSpec) : undefined);
  // Validate the Developer role/profile before confirmation or worktree creation.
  compileAgent(spec, 'developer', { task: {} });
  const count = tasks.length * args.repeat!;
  if (!args.yes && !(await (options.confirm ?? confirmRun)(count)))
    throw new CliUsageError('Evaluation cancelled; no executions launched');
  assertEvalRunAllowed();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const verificationDirectory = resolveInside(common, 'softwareagents/runtime/evals');
  fs.mkdirSync(verificationDirectory, { recursive: true, mode: 0o700 });
  const runId = randomUUID();
  const file = resolveInside(directory, `${runId}.jsonl`);
  const fd = fs.openSync(file, 'wx', 0o600);
  const rows: EvalRecord[] = [];
  const bankHash = hash(bank);
  try {
    executionLoop: for (const task of tasks)
      for (let repetition = 1; repetition <= args.repeat!; repetition++) {
        assertEvalRunAllowed();
        const start = Date.now();
        const scratch = fs.mkdtempSync(path.join(verificationDirectory, 'verify-'));
        let tree: Awaited<ReturnType<typeof createEvalWorktree>> | undefined;
        let safeToCleanup = true;
        let interrupted = false;
        const stop = () => {
          interrupted = true;
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        const row: EvalRecord = {
          version: 1,
          runId,
          project: config.project.id,
          task: task.id,
          taskHash: hash(task),
          bankHash,
          baseCommit: task.baseCommit,
          executor,
          tier,
          agentSpecHash: hash(spec),
          baseline: !args.agentSpec,
          repetition,
          status: 'executor_error',
          criteria: [],
          durationMs: 0,
          metrics: {},
        };
        try {
          tree = await createEvalWorktree(cwd, common, task.baseCommit);
          if (interrupted) throw new Error('Evaluation interrupted');
          const result = await runWorker(
            {
              task: `SA-${BigInt('0x' + randomUUID().replace(/-/g, '').slice(0, 12))
                .toString()
                .padStart(3, '0')}`,
              brief: 'eval:in-memory',
            },
            {
              ...options.worker,
              cwd,
              log: () => {},
              evaluation: {
                worktreePath: tree.path,
                executor,
                tier,
                agentSpec: spec,
                brief: task.brief,
                timeoutMin: task.timeoutMin,
                settled: (span, confirmed) => {
                  safeToCleanup = confirmed;
                  if (span) {
                    const attrs = telemetryAttributes(span);
                    const executionId = attrs['softwareagents.execution.id'];
                    if (typeof executionId === 'string') row.executionId = executionId;
                    row.metrics = Object.fromEntries(
                      EVAL_METRIC_FIELDS.filter((key) => attrs[key] !== undefined).map((key) => [
                        key,
                        attrs[key],
                      ]),
                    );
                  }
                },
              },
            },
          );
          if (result.evaluationSuccess === undefined) row.status = 'blocked';
          else if (result.evaluationSuccess && !interrupted) {
            try {
              assertEvalIntegrity(task, tree.path);
            } catch {
              row.status = 'criteria_tampered';
            }
            if (row.status !== 'criteria_tampered') {
              row.criteria = await checkEvalCriteria(task, cwd, tree.path, scratch);
              row.status = row.criteria.every(Boolean) ? 'success' : 'criterion_failed';
            }
          }
        } catch (error) {
          if (error instanceof EvalCriterionTerminationError) safeToCleanup = false;
          // Exception messages can contain CLI output or user paths. Persist a fixed category only.
          row.status = 'executor_error';
        } finally {
          row.durationMs = Math.max(0, Date.now() - start);
          const model = row.metrics['gen_ai.response.model'];
          const prices = config.operator.telemetry?.prices;
          if (typeof model === 'string' && prices && Object.hasOwn(prices, model))
            row.price = prices[model];
          try {
            try {
              fs.writeFileSync(fd, JSON.stringify(parseEvalRecord(row)) + '\n');
              fs.fsyncSync(fd);
              rows.push(row);
            } finally {
              if (tree && safeToCleanup) await tree.cleanup();
            }
            if (!safeToCleanup)
              throw new Error(
                'Executor termination unconfirmed; eval worktree retained for operator inspection',
              );
          } finally {
            process.removeListener('SIGINT', stop);
            process.removeListener('SIGTERM', stop);
            if (safeToCleanup) fs.rmSync(scratch, { recursive: true, force: true });
          }
        }
        if (interrupted)
          throw new CliUsageError('Evaluation interrupted; completed metrics recorded');
        if (row.status === 'blocked') break executionLoop; // Do not repeatedly probe a configuration that cannot launch.
      }
  } finally {
    fs.closeSync(fd);
  }
  const { records, invalidLines } = await readEvalRecords(directory);
  const report = buildEvalReport(records);
  log(
    args.json
      ? JSON.stringify(
          {
            runId,
            plannedExecutions: count,
            recordedExecutions: rows.length,
            results: rows,
            ...report,
            invalidLines,
          },
          null,
          2,
        )
      : formatReport(report),
  );
  process.exitCode = rows.some((r) => r.status === 'blocked')
    ? 3
    : rows.some((r) => r.status !== 'success')
      ? 1
      : 0;
}

function formatReport(report: ReturnType<typeof buildEvalReport>): string {
  if (!report.configurations.length) return 'No eval results';
  return report.configurations
    .map((c) =>
      [
        `${c.executor}/${c.tier}/${c.model} spec=${c.agentSpecHash.slice(0, 12)}${c.baseline ? ' base' : ''}`,
        `success=${c.successes}/${c.attempts} rate=${c.successRate} blocked=${c.blocked}`,
        `cost/solved USD=${c.costPerSolvedTaskUsd} tokens(in/out/cache)=${c.totals.inputTokens}/${c.totals.outputTokens}/${c.totals.cacheReadTokens}`,
        `time=${c.durationMs}ms consistency=${c.consistency} pareto=${c.pareto}`,
        ...c.regressions.map((r) => `REGRESSION ${r.task}: ${r.baselineRate} -> ${r.rate}`),
      ].join('\n'),
    )
    .join('\n\n');
}
