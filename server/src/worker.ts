import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

import * as agentSchema from '../../core/schemas/agent-spec.schema.json';
import type { AgentSpec } from '../../core/src/agentSpec.js';
import type { CascadeVerifier, ModelTier } from '../../core/src/modelTier.js';
import type { ProjectConfig } from '../../core/src/project.js';
import { compileAgent, ROLE_PROFILES, TOOL_POLICY_VERSION } from './agentCompiler.js';
import { type AuditEntry, AuditLog, recordAudit } from './auditLog.js';
import { CliUsageError } from './cliErrors.js';
import { readConfig } from './configPersistence.js';
import { type CriterionResult, EvalCriterionTerminationError } from './evalCriteria.js';
import { assertEvalRunAllowed } from './evalGuard.js';
import { EvalIntegrityError } from './evalIntegrity.js';
import {
  closeAvailabilityDecisions,
  escalateUnavailable,
  executorAuthorityBlock,
} from './executorAvailability.js';
import { observeExecutors, type ProbeRunner, runProbe } from './executorProbes.js';
import { ClaudeCliExecutor } from './executors/claudeCliExecutor.js';
import { CodexCliExecutor } from './executors/codexCliExecutor.js';
import { ExecutionRegistry } from './executors/executionRegistry.js';
import type { ExecutionHandle } from './executors/executor.js';
import { guardProtectedPaths } from './executors/protectedPaths.js';
import { WorktreeManager } from './executors/worktreeManager.js';
import {
  excludeCandidate,
  type ExecutionBlock,
  launchBlock,
  selectExecutor,
  type SelectionBlock,
  selectionBlock,
  type SelectionSnapshot,
  unprovenWait,
} from './executorSelection.js';
import {
  acquireExecutorSlot,
  executorSlotsDirectory,
  withMachineAdmission,
} from './executorSlots.js';
import { HumanDecisions } from './humanDecisions.js';
import {
  type CascadeAttempt,
  cascadeLevels,
  cascadeUsage,
  checkCascadeCriteria,
  resetCascadeWorktree,
} from './modelCascade.js';
import { loadModelPolicy, loadTierRule } from './modelPolicy.js';
import { admitModelTier } from './modelTierAdmission.js';
import {
  initialModelTier,
  MODEL_TIERS,
  type TierInputs,
  type TierSelection,
  validateModelTierSupport,
} from './modelTiers.js';
import { resolveInside } from './pathGuard.js';
import { evaluatePolicy, type PolicyDecision } from './policy.js';
import { loadProjectConfig } from './projectConfig.js';
import { readSelectionSnapshot } from './quotaCommand.js';
import { type MachineQuotaPolicy, type QuotaDecision, quotaGate } from './quotaGate.js';
import { compileSchema, validateSchema } from './schemaValidation.js';
import { taskModelInputs } from './taskModelInputs.js';
import { ExecutionTelemetry, TelemetrySink, type TelemetrySpan } from './telemetry.js';
import { WorkerLifecycle } from './workerLifecycle.js';
import { openWorkStore } from './workstore/SqliteWorkStore.js';
import type { WorkStore } from './workstore/WorkStore.js';

export interface WorkerArgs {
  task: string;
  brief?: string;
  executor?: 'claude' | 'codex';
  selectExecutor?: boolean;
}

/** Use the brief heading as written, with the task key only in the commit scope. */
export function workerCommitSubject(task: string, brief: string): string {
  const heading = (brief.split(/\r?\n/).find((line) => line.trim()) ?? '')
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ');
  const summary = heading
    .replace(new RegExp(`^${task}(?=\\s|[·:—–-]|$)\\s*[·:—–-]?\\s*`, 'i'), '')
    .trim()
    .slice(0, 100);
  return `feat(${task}): ${summary || 'implementar tarea supervisada'}`;
}

export function parseWorkerArgs(argv: string[]): WorkerArgs {
  if (argv[0] !== 'run')
    throw new CliUsageError(
      'Usage: pixel-agents worker run --task SA-### [--executor claude|codex] [--brief <file>]',
    );
  const values: Record<string, string> = {};
  let selection = false;
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i];
    if (key === '--select-executor' && !selection) {
      selection = true;
      i--;
      continue;
    }
    const value = argv[i + 1];
    if (
      !['--task', '--brief', '--executor'].includes(key) ||
      !value ||
      value.startsWith('--') ||
      values[key]
    )
      throw new CliUsageError('Expected unique --task, --brief and --executor values');
    values[key] = value;
  }
  if (
    !/^SA-\d{3,}$/.test(values['--task'] ?? '') ||
    (values['--executor'] && !['claude', 'codex'].includes(values['--executor']))
  )
    throw new CliUsageError(
      'Expected --task SA-###, optional --executor claude|codex and --brief <file>',
    );
  return {
    task: values['--task'],
    ...(values['--brief'] ? { brief: values['--brief'] } : {}),
    ...(values['--executor'] ? { executor: values['--executor'] as 'claude' | 'codex' } : {}),
    ...(selection ? { selectExecutor: true } : {}),
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function requireGitIdentity(cwd: string): void {
  try {
    for (const identity of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'])
      execFileSync('git', ['var', identity], {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
  } catch {
    throw new CliUsageError(
      'worker run requires valid Git author and committer identity; configure it before launching',
    );
  }
}

/** Fail closed even for dead owners: an executor child may still be alive.
 * The operator verifies both processes before removing a stale lock. */
export function acquireTaskLock(commonDirectory: string, task: string): () => void {
  if (!/^SA-\d{3,}$/.test(task)) throw new Error('Invalid task key');
  const file = resolveInside(commonDirectory, `softwareagents/locks/${task}.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(
      `Task locked: ${file}. Verify owner PID and executor child have stopped before removing it.`,
    );
  }
  try {
    fs.writeFileSync(fd, String(process.pid));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return () => fs.unlinkSync(file);
}

export interface WorkerOptions {
  cwd?: string;
  /** Injection for protocol tests only; CLI obtains binary exclusively from Operator config. */
  binaryArgs?: readonly string[];
  log?: (message: string) => void;
  /** Probe runner for the launch-time availability check; defaults to real probes. */
  probe?: ProbeRunner;
  /** Internal eval runner only: same launch path, disposable detached tree, no commit. */
  evaluation?: {
    worktreePath: string;
    executor: 'claude' | 'codex';
    tier: ModelTier;
    /** Exact Operator verifier binding for an explicitly requested cascade eval. */
    cascadeTask?: string;
    /** Eval bank integrity ceiling applies before every cascade verifier as well. */
    allowedPaths: string[];
    agentSpec?: AgentSpec;
    /** Kept in memory; eval result storage must never contain a brief/prompt file. */
    brief: string;
    timeoutMin: number;
    settled: (span: TelemetrySpan | undefined, terminationConfirmed: boolean) => void;
  };
}

/** Manual runs without a quota policy keep conservative defaults (SA-036). */
function legacyMachinePolicy(snapshot: SelectionSnapshot, executor: 'claude' | 'codex') {
  snapshot.machinePolicy ??= { quotaThresholds: {}, maxConcurrent: {} };
  snapshot.machinePolicy.quotaThresholds[executor] ??= 0;
  snapshot.machinePolicy.maxConcurrent[executor] ??= 1;
  return snapshot.machinePolicy as MachineQuotaPolicy;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function loadWorkerAgentSpec(file?: string, role = 'developer'): AgentSpec {
  if (!Object.hasOwn(ROLE_PROFILES, role)) throw new CliUsageError('Unsupported task role');
  const template = path.join(__dirname, `agents/templates/${role}.yaml`);
  const source = path.resolve(__dirname, `../../agents/templates/${role}.yaml`);
  return validateSchema(
    compileSchema<AgentSpec>(agentSchema),
    parse(fs.readFileSync(file ?? (fs.existsSync(template) ? template : source), 'utf8')),
  );
}

export interface WorkerResult {
  branch: string;
  commit: string | null;
  stat: string;
  quotaDecision?: QuotaDecision;
  policyDecision?: PolicyDecision;
  /** SA-090: waiting needs the Operator; the deduplicated Human Decision, if recorded. */
  availabilityBlock?: { code: SelectionBlock['code']; decisionId: string | null };
  blockedCause?: ExecutionBlock;
  evaluationSuccess?: boolean;
  evaluationVerifierFailed?: boolean;
}

/** Only fixed categories and a numeric exit code cross into Task/audit storage. */
function failureDiagnostic(detail: string, exitCode?: number): string {
  const category = /policy violation|containment/i.test(detail)
    ? 'containment'
    : /timed? ?out|timeout/i.test(detail)
      ? 'timeout'
      : /auth|not logged in|invalid_api_key/i.test(detail)
        ? 'auth'
        : /spawn|ENOENT|EACCES|launch process/i.test(detail)
          ? 'spawn'
          : /cancel|interrupt/i.test(detail)
            ? 'cancelled'
            : /lease/i.test(detail)
              ? 'lease'
              : /worktree|git/i.test(detail)
                ? 'workspace'
                : 'executor';
  return `category=${category}; exit_code=${Number.isSafeInteger(exitCode) ? exitCode : 'unknown'}`;
}

class WorkerExecutionError extends Error {}

export async function runWorker(
  args: WorkerArgs,
  options: WorkerOptions = {},
): Promise<WorkerResult> {
  if (options.evaluation) return runWorkerExecution(args, options);
  // SA-026 currently verifies Windows creation identities/trees only. Refuse
  // before creating state, claiming a lease, probing or preparing any work.
  if (process.platform !== 'win32')
    throw new CliUsageError(
      'worker run requires Windows: POSIX process-tree recovery is not supported',
    );
  const cwd = options.cwd ?? process.cwd();
  const config = loadProjectConfig(cwd, true);
  if (!config)
    throw new CliUsageError(
      'worker run requires .softwareagents/project.yaml in the main checkout',
    );
  requireGitIdentity(cwd);
  if (!/^SA-\d{3,}$/.test(args.task)) throw new CliUsageError('Invalid task key');
  const common = path.resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']));
  const legacyLock = resolveInside(common, `softwareagents/locks/${args.task}.lock`);
  if (fs.existsSync(legacyLock))
    throw new CliUsageError(
      `Task locked: ${legacyLock}. Verify legacy worker and executor have stopped before removing it.`,
    );
  const store = await openWorkStore({ repositoryPath: cwd, projectId: config.project.id });
  const lifecycle = new WorkerLifecycle(store, args.task);
  try {
    // Availability decisions must be re-evaluated by selection before claim.
    if (store.getTask(args.task)?.status !== 'WAITING_HUMAN') await lifecycle.claim();
    const result = await runWorkerExecution(args, options, lifecycle, config);
    if (result.quotaDecision?.status === 'wait') await lifecycle.wait(result.quotaDecision);
    else if (!result.availabilityBlock && !result.policyDecision)
      await lifecycle.finish(
        'REVIEW',
        result.commit ? `Runtime commit ${result.commit}` : 'Execution finished without changes',
      );
    return result;
  } catch (error) {
    await lifecycle.finish(
      'FAILED_RETRYABLE',
      error instanceof WorkerExecutionError
        ? error.message
        : `Worker failed (${failureDiagnostic(error instanceof Error ? error.message : '')})`,
    );
    throw error;
  } finally {
    await lifecycle.stopHeartbeat();
    store.close();
  }
}

async function runWorkerExecution(
  args: WorkerArgs,
  options: WorkerOptions,
  lifecycle?: WorkerLifecycle,
  initialConfig?: ProjectConfig,
): Promise<WorkerResult> {
  if (options.evaluation) assertEvalRunAllowed();
  const telemetryStart = Date.now();
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? console.log;
  const config = initialConfig ?? loadProjectConfig(cwd, true);
  if (!config)
    throw new CliUsageError(
      'worker run requires .softwareagents/project.yaml in the main checkout',
    );
  const decision = evaluatePolicy('launch_execution', 'human', config.operator.autonomyLevel);
  let executionId = randomUUID();
  let tierSelection: TierSelection | undefined;
  const audit = (status: string, details: Omit<AuditEntry['outcome'], 'status'> = {}) =>
    recordAudit(
      'launch_execution',
      'execution',
      executionId,
      {
        status,
        ...details,
        ...(tierSelection
          ? {
              tier: tierSelection.tier,
              executor: tierSelection.choice?.executor ?? null,
              model: tierSelection.choice?.model ?? null,
              effort: tierSelection.choice?.effort ?? null,
              reason: tierSelection.reason,
            }
          : {}),
      },
      {
        projectId: config.project.id,
        actorType: 'human',
        actorId: 'operator',
        taskKey: args.task,
        executionId,
        policyDecision: decision,
        input: args,
      },
    );
  if (decision.outcome !== 'allow' || !readConfig().projects[config.project.id]) {
    audit('denied');
    throw new CliUsageError('Operator config must authorize execution for this Project');
  }
  audit('policy_allowed');
  // Resolve/read before any launch; task data never selects executable or authority.
  const brief =
    options.evaluation?.brief ??
    (args.brief
      ? fs.readFileSync(path.resolve(cwd, args.brief), 'utf8')
      : JSON.stringify(lifecycle?.store.getTask(args.task) ?? { key: args.task }));
  const role =
    lifecycle?.store.getTask(args.task)?.agent_role ??
    options.evaluation?.agentSpec?.identity.role ??
    'developer';
  const spec = validateSchema(
    compileSchema<AgentSpec>(agentSchema),
    options.evaluation?.agentSpec ?? loadWorkerAgentSpec(undefined, role),
  );
  const taskData = {
    task: { key: args.task, brief },
    repository: { projectId: config.project.id },
  };
  const compiled = compileAgent(spec, role, taskData);
  // Explicit selection only narrows the Operator catalog.
  const tierPolicy =
    config.operator.modelTiers && args.executor
      ? ({
          ...config.operator.modelTiers,
          tiers: Object.fromEntries(
            Object.entries(config.operator.modelTiers.tiers).map(([tier, value]) => [
              tier,
              {
                ...value,
                candidates: value!.candidates.filter((c) => c.executor === args.executor),
              },
            ]),
          ),
        } as typeof config.operator.modelTiers)
      : config.operator.modelTiers;
  if (options.evaluation && !tierPolicy)
    throw new CliUsageError('eval run requires an Operator modelTiers catalog');
  const tierRule = tierPolicy ? (tierPolicy.rule ?? loadTierRule(cwd)) : undefined;
  const loadedPolicy = !tierPolicy && args.selectExecutor ? loadModelPolicy(cwd) : undefined;
  const modelPolicy =
    loadedPolicy && args.executor
      ? Object.fromEntries(
          Object.entries(loadedPolicy).map(([key, choices]) => [
            key,
            choices!.filter((c) => c.executor === args.executor),
          ]),
        )
      : loadedPolicy;
  let selection = modelPolicy
    ? selectExecutor(spec, modelPolicy, readSelectionSnapshot(config.operator))
    : undefined;
  let admissionTier: ModelTier | null = null;
  const blockedCause = (gate: QuotaDecision, found?: SelectionBlock): ExecutionBlock => {
    const tier = tierSelection?.requestedTier ?? admissionTier;
    const exclusions = found?.exclusions ?? tierSelection?.exclusions ?? [];
    const candidates = tier ? tierPolicy?.tiers[tier]?.candidates : undefined;
    return {
      code: found?.code ?? gate.cause ?? 'admission_busy',
      tier,
      executor:
        tierSelection?.choice?.executor ??
        found?.exclusions.find((e) => e.code === found.code)?.executor ??
        found?.exclusions[0]?.executor ??
        (candidates?.length === 1 ? candidates[0].executor : undefined) ??
        selection?.choice?.executor ??
        null,
      reason: gate.reason,
      exclusions,
    };
  };
  /**
   * SA-090: waiting cannot fix this (disabled, no level, CLI missing/unsupported/
   * logged out). One deduplicated Human Decision per Project, scope and cause
   * blocks the Task; failing to record it never turns the wait into a launch.
   */
  const escalate = async (
    found: SelectionBlock,
    gate: QuotaDecision,
    scope: string,
    open?: WorkStore,
  ) => {
    let decisionId: string | null = null;
    const cause = blockedCause(gate, found);
    audit('availability_blocked', { blockedCause: cause });
    if (options.evaluation) {
      return {
        branch: '',
        commit: null,
        stat: '',
        quotaDecision: gate,
        availabilityBlock: { code: found.code, decisionId },
        blockedCause: cause,
      };
    }
    try {
      const { openWorkStore } = await import('./workstore/SqliteWorkStore.js');
      const store =
        open ?? (await openWorkStore({ repositoryPath: cwd, projectId: config.project.id }));
      try {
        await lifecycle?.idleForDecision(found.code);
        const result = await escalateUnavailable(
          store,
          config.operator.autonomyLevel,
          args.task,
          scope,
          found,
          executionId,
        );
        decisionId = result.decisionId;
        log(
          `${found.code}: ${args.task} waits for the operator (Human Decision ${decisionId}${result.created ? '' : ', already open'})`,
        );
      } finally {
        if (!open) store.close();
      }
    } catch (error) {
      log(`${found.code}: Human Decision not recorded: ${(error as Error).message}`);
    }
    log(gate.reason);
    process.exitCode = 3;
    return {
      branch: '',
      commit: null,
      stat: '',
      quotaDecision: { ...gate, cause: 'disabled' } as QuotaDecision,
      availabilityBlock: { code: found.code, decisionId },
      blockedCause: cause,
    };
  };
  const common = path.resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']));
  // Identity is checked without writing Git configuration or consuming a runtime slot.
  try {
    for (const identity of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'])
      if (!options.evaluation)
        execFileSync('git', ['var', identity], {
          cwd,
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
  } catch {
    throw new CliUsageError(
      'worker run requires valid Git author and committer identity; configure it before launching',
    );
  }
  const release = options.evaluation ? acquireTaskLock(common, args.task) : () => {};
  let handle: ExecutionHandle | undefined;
  let interrupted = false;
  let executionFinished = false;
  let eventsStarted = false;
  let slotFailure: unknown;
  let slot: ReturnType<typeof acquireExecutorSlot>;
  const workStore = lifecycle?.store;
  let telemetry: ExecutionTelemetry | undefined;
  let telemetryStatus: 'ok' | 'error' | 'require_human' = 'error';
  const verifierAbort = new AbortController();
  let verifierClosed = true;
  let attempt = 0;
  let escalatedFrom: ModelTier | undefined;
  let cascade: NonNullable<typeof tierPolicy>['cascade'];
  let verifier: CascadeVerifier | undefined;
  let usingDefaultVerifier = false;
  let levels: ModelTier[] = [];
  let tree: { path: string; branch: string };
  let base: string;
  let attemptRecorded = false;
  let exitCode: number | undefined;
  let executionDiagnostic: string | undefined;
  let runtimeQuota: QuotaDecision | undefined;
  const recordAttempt = async (results: CriterionResult[], result: CascadeAttempt['result']) => {
    if (!verifier || !telemetry || !tree || attemptRecorded || !tierSelection?.choice) return;
    const outcome: CascadeAttempt = {
      attempt: attempt + 1,
      escalatedFrom,
      tier: tierSelection.tier!,
      executor: tierSelection.choice.executor,
      model: tierSelection.choice.model,
      verifiers: results,
      result,
      usage: cascadeUsage(telemetry.usageAttributes, config.operator),
    };
    // A failed append must not be retried by the fallback in finally.
    attemptRecorded = true;
    try {
      new ExecutionRegistry(tree.path).cascadeAttempt(executionId, args.task, outcome);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
      log(`Cascade attempt persistence failed: ${code}`);
      audit('cascade_attempt_persistence_error', { code, attempt: attempt + 1 });
      throw error;
    }
    recordAudit(
      'launch_execution',
      'execution',
      executionId,
      { status: 'cascade_attempt', cascade: outcome },
      {
        projectId: config.project.id,
        actorType: 'system',
        actorId: 'worker',
        taskKey: args.task,
        executionId,
        policyDecision: decision,
      },
    );
  };
  const cancel = () => {
    interrupted = true;
    verifierAbort.abort();
    try {
      handle?.cancel();
    } catch {
      log('Executor cancellation failed; verify processes before recovering the task lock.');
    }
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  // Re-checked inside machine admission, which availability changes also hold (SA-088).
  const authorityBlock = () => executorAuthorityBlock(config.project.id, config.operator);
  const probe = options.probe ?? runProbe;
  // SA-090: the server's probe cache lives in another process; probe what may launch.
  const probed: ('claude' | 'codex')[] =
    options.evaluation && !options.evaluation.cascadeTask
      ? [options.evaluation.executor]
      : tierPolicy || modelPolicy
        ? (['claude', 'codex'] as const).filter((id) =>
            config.operator.allowedExecutors.includes(id),
          )
        : config.operator.allowedExecutors.includes(args.executor ?? 'claude')
          ? [args.executor ?? 'claude']
          : [];
  let scope = modelPolicy
    ? `capability:${spec.modelPolicy.capabilityClass}`
    : `executor:${args.executor ?? 'claude'}`;
  let invalidated: string | undefined;
  /** Never launched: release the slot; retry reselects and reuses the clean task worktree. */
  const invalidatedResult = (reason: string) => {
    log(`Selection invalidated before spawn: ${reason}`);
    audit('selection_invalidated');
    process.exitCode = 3;
    return {
      branch: '',
      commit: null,
      stat: '',
      quotaDecision: {
        status: 'wait',
        resetsAt: null,
        reason,
        cause: 'selection',
      } as QuotaDecision,
    };
  };
  try {
    const normalInputs: TierInputs =
      options.evaluation && !options.evaluation.cascadeTask
        ? { evaluation: { tier: options.evaluation.tier, executor: options.evaluation.executor } }
        : options.evaluation
          ? {}
          : tierPolicy
            ? taskModelInputs(config, workStore?.getTask(args.task), args.task)
            : {};
    cascade = tierPolicy?.cascade;
    if (
      cascade?.enabled &&
      tierPolicy &&
      tierRule &&
      (!options.evaluation || options.evaluation.cascadeTask) &&
      MODEL_TIERS.indexOf(initialModelTier(spec, tierRule, tierPolicy, normalInputs).tier) >=
        MODEL_TIERS.indexOf(cascade.startTier)
    ) {
      const key = options.evaluation?.cascadeTask ?? args.task;
      usingDefaultVerifier = !Object.hasOwn(cascade.verifiers, key) && !!cascade.defaultVerifier;
      verifier = Object.hasOwn(cascade.verifiers, key)
        ? cascade.verifiers[key]
        : cascade.defaultVerifier;
      if (verifier && options.evaluation)
        verifier = {
          ...verifier,
          allowedPaths: (verifier.allowedPaths ?? options.evaluation.allowedPaths).filter((file) =>
            options.evaluation!.allowedPaths.includes(file),
          ),
        };
      if (verifier) levels = cascadeLevels(tierPolicy, config.operator);
    }
    if (options.evaluation?.cascadeTask && !verifier)
      throw new CliUsageError(
        'Cascade eval requires an enabled, eligible Operator verifier binding',
      );
    for (;;) {
      const inputs: TierInputs = verifier ? { cascadeTier: levels[attempt] } : normalInputs;
      tierSelection = undefined;
      admissionTier =
        tierPolicy && tierRule
          ? initialModelTier(spec, tierRule, tierPolicy, inputs).requested
          : null;
      let selectedExecutor = args.executor ?? selection?.choice?.executor ?? 'claude';
      let availability: SelectionSnapshot['availability'];
      // Both locks are held during the fresh gate decision and exclusive slot creation.
      // The admission lock spans projects/tasks; the slot spans the entire Execution.
      const tierAdmission =
        tierPolicy && tierRule
          ? await (async () => {
              availability = await observeExecutors(probed, config.operator, probe);
              validateModelTierSupport(
                tierPolicy,
                config.operator.binaryPaths?.claude,
                spec,
                tierRule,
                inputs,
                probed.filter((id) => !launchBlock(availability?.[id], nowSeconds())),
                config.operator.executorLevels,
              );
              return admitModelTier(
                spec,
                tierRule,
                tierPolicy,
                inputs,
                config.operator,
                executionId,
                authorityBlock,
                availability,
              );
            })()
          : undefined;
      if (!tierPolicy) availability = await observeExecutors(probed, config.operator, probe);
      let legacyBlock: SelectionBlock | undefined;
      if (tierAdmission) {
        tierSelection = tierAdmission.selection;
        scope = `tier:${tierSelection.requestedTier ?? 'none'}`;
        selectedExecutor = tierSelection.choice?.executor ?? 'claude';
        log(
          JSON.stringify({
            ...tierSelection,
            coverage: tierAdmission.snapshot.coverage,
            active: tierAdmission.snapshot.active,
            maxExecutions: tierAdmission.snapshot.machinePolicy?.maxExecutions ?? null,
            activeTotal:
              (tierAdmission.snapshot.active.claude ?? 0) +
              (tierAdmission.snapshot.active.codex ?? 0),
          }),
        );
      }
      const admission = tierPolicy
        ? tierAdmission
          ? { gate: tierAdmission.selection.gate, slot: tierAdmission.slot }
          : undefined
        : withMachineAdmission(executionId, (owners) => {
            const blocked = authorityBlock();
            if (blocked)
              return {
                gate: {
                  status: 'wait',
                  resetsAt: null,
                  reason: blocked,
                  cause: 'configuration',
                } as QuotaDecision,
                slot: undefined,
              };
            const snapshot = readSelectionSnapshot(config.operator);
            snapshot.availability = availability;
            if (modelPolicy) {
              selection = selectExecutor(spec, modelPolicy, snapshot);
              // The fresh decision, not the pre-admission preview, owns the slot.
              if (selection.choice) selectedExecutor = selection.choice.executor;
              legacyBlock = selection.block;
            }
            // Legacy manual runs retain conservative defaults for pre-quota configs.
            if (!modelPolicy) {
              legacyMachinePolicy(snapshot, selectedExecutor);
              const excluded = excludeCandidate(selectedExecutor, snapshot);
              if (excluded) {
                legacyBlock = selectionBlock(1, false, [
                  { executor: selectedExecutor, code: excluded },
                ]);
                return {
                  gate: {
                    status: 'wait',
                    resetsAt: null,
                    reason: `${selectedExecutor}: ${excluded}`,
                    cause: 'disabled',
                  } as QuotaDecision,
                  slot: undefined,
                };
              }
            }
            log(
              JSON.stringify({
                executor: selectedExecutor,
                active: snapshot.active[selectedExecutor],
                coverage: snapshot.coverage,
                maxExecutions: snapshot.machinePolicy?.maxExecutions ?? null,
                activeTotal: (snapshot.active.claude ?? 0) + (snapshot.active.codex ?? 0),
              }),
            );
            if (selection && !selection.choice) return { gate: selection.gate, slot: undefined };
            const gate =
              selection?.gate ??
              unprovenWait(selectedExecutor, snapshot) ??
              quotaGate(
                selectedExecutor,
                snapshot.machinePolicy,
                snapshot.capacities[selectedExecutor],
                snapshot.active[selectedExecutor] ?? NaN,
                snapshot.nowS,
                (snapshot.active.claude ?? 0) + (snapshot.active.codex ?? 0),
              );
            if (gate.status === 'wait') return { gate, slot: undefined };
            const reserved = acquireExecutorSlot(
              selectedExecutor,
              gate.concurrencyLimit,
              owners[selectedExecutor],
              snapshot.machinePolicy?.maxExecutions,
            );
            return {
              gate: reserved
                ? gate
                : ({
                    status: 'wait',
                    resetsAt: null,
                    reason: `${selectedExecutor}: no free runtime executor slot; inspect ${executorSlotsDirectory(selectedExecutor)}`,
                  } as QuotaDecision),
              slot: reserved,
            };
          });
      const admissionGate =
        admission?.gate ??
        ({
          status: 'wait',
          resetsAt: null,
          reason: `${selectedExecutor}: runtime admission is busy; inspect ${executorSlotsDirectory(selectedExecutor)}`,
        } as QuotaDecision);
      slot = admission?.slot;
      if (selection) log(selection.reason);
      const block = tierAdmission ? tierAdmission.selection.block : legacyBlock;
      if (block && !slot) return await escalate(block, admissionGate, scope, workStore);
      if (admissionGate.status === 'wait' || !slot) {
        log(admissionGate.reason);
        const cause = blockedCause(admissionGate);
        audit('quota_wait', { blockedCause: cause });
        process.exitCode = 3;
        return {
          branch: '',
          commit: null,
          stat: '',
          quotaDecision: admissionGate,
          blockedCause: cause,
        };
      }
      // Admitted: any availability block for this scope no longer holds (SA-090).
      try {
        const { openWorkStore } = await import('./workstore/SqliteWorkStore.js');
        const store = options.evaluation
          ? undefined
          : (workStore ??
            (fs.existsSync(path.join(common, 'softwareagents/work.sqlite3'))
              ? await openWorkStore({ repositoryPath: cwd, projectId: config.project.id })
              : undefined));
        try {
          const closed = store ? await closeAvailabilityDecisions(store, scope, executionId) : [];
          if (closed.length) log(`Availability restored for ${scope}: closed ${closed.join(', ')}`);
        } finally {
          if (store !== workStore) store?.close();
        }
      } catch (error) {
        log(`Availability decisions for ${scope} not closed: ${(error as Error).message}`);
      }
      telemetry = new ExecutionTelemetry(
        new TelemetrySink(common, config.project.id, config.operator.telemetry),
        {
          executionId,
          taskKey: args.task,
          executor: selectedExecutor,
          agent: spec.metadata.id,
          role,
          model: tierSelection?.choice?.model ?? selection?.choice?.model,
          tier: tierSelection?.tier ?? undefined,
          effort: tierSelection?.choice?.effort,
          ...(verifier ? { cascade: { attempt: attempt + 1, escalatedFrom } } : {}),
        },
        attempt ? Date.now() : telemetryStart,
      );
      await lifecycle?.claim();
      if (workStore) {
        if (!workStore.getTask(args.task))
          workStore.createTask({ key: args.task, type: 'unknown', status: 'DRAFT' });
        await workStore.createExecution({
          key: executionId,
          task_key: args.task,
          agent_template_version: spec.metadata.version,
          executor: selectedExecutor,
          model_id: tierSelection?.choice?.model ?? selection?.choice?.model ?? '',
          model_tier: tierSelection?.tier,
          model_effort: tierSelection?.choice?.effort ?? null,
          selection_reason:
            tierSelection?.reason ?? selection?.reason ?? `Explicit worker: ${selectedExecutor}`,
          session_id: null,
          // Supervisor registration is fenced before ACK, after preparation.
          pid: null,
          started_at: new Date().toISOString(),
          system_prompt_hash:
            selectedExecutor === 'codex'
              ? createHash('sha256').update(compiled.codex.instructions).digest('hex')
              : compiled.systemPromptHash,
          project_brain_sha: git(cwd, ['rev-parse', 'HEAD']),
          task_version: workStore.getTask(args.task)!.version,
          tool_policy_version: TOOL_POLICY_VERSION,
        });
      }
      audit('quota_admitted');
      if (tierSelection)
        new AuditLog().append({
          projectId: config.project.id,
          actorType: 'human',
          actorId: 'operator',
          action: 'launch_execution',
          resourceType: 'execution',
          resourceId: executionId,
          policyDecision: decision,
          riskLevel: 'medium',
          taskKey: args.task,
          executionId,
          input: args,
          outcome: {
            status: 'model_selected',
            tier: tierSelection.tier,
            executor: tierSelection.choice!.executor,
            model: tierSelection.choice!.model,
            effort: tierSelection.choice!.effort ?? null,
            reason: tierSelection.reason,
          },
        });
      tree ??= options.evaluation
        ? { path: options.evaluation.worktreePath, branch: '' }
        : await new WorktreeManager({
            repositoryPath: cwd,
            defaultBranch: config.project.repo.defaultBranch,
            manualPreparation: true,
          }).create(args.task, 'worker');
      if (git(tree.path, ['status', '--porcelain', '--untracked-files=all']))
        throw new Error('Existing task worktree is dirty; review it before retrying');
      base ??= git(tree.path, ['rev-parse', 'HEAD']);
      if (lifecycle)
        await workStore!.setTaskWorktree(args.task, lifecycle.owner, tree.branch, tree.path);
      audit('worktree_prepared');
      audit('agent_compiled', {
        detail: JSON.stringify({ role, toolPolicyVersion: TOOL_POLICY_VERSION }),
      });
      if (interrupted) throw new Error('Worker interrupted');
      /**
       * SA-090: preparation is lazy and slow, so the selection is revalidated after
       * it, immediately before the executor starts, under machine admission like
       * SA-088: authority, a fresh probe and quota. That check is the frontier: a
       * change before it invalidates the run (no process, slot released); a change
       * after it drains. Not inside registerProcess: a refused registration ends the
       * Execution as failed (the supervisor is killed before ACK), which would turn a
       * policy change into a failure instead of a clean invalidation.
       */
      const spawnObservation = (await observeExecutors([selectedExecutor], config.operator, probe))[
        selectedExecutor
      ];
      const machinePolicyFor = (snapshot: SelectionSnapshot) =>
        tierPolicy || modelPolicy
          ? snapshot.machinePolicy
          : legacyMachinePolicy(snapshot, selectedExecutor);
      const revalidate = (): string | undefined => {
        const blocked = authorityBlock();
        if (blocked) return blocked;
        const verdict = launchBlock(spawnObservation, nowSeconds());
        if (verdict) return `${selectedExecutor}: ${verdict.code}`;
        const snapshot = readSelectionSnapshot(config.operator);
        // This run already holds its slot: discount it; concurrency was decided then.
        const gate = quotaGate(
          selectedExecutor,
          machinePolicyFor(snapshot),
          snapshot.capacities[selectedExecutor],
          (snapshot.active[selectedExecutor] ?? NaN) - 1,
          snapshot.nowS,
          (snapshot.active.claude ?? 0) + (snapshot.active.codex ?? 0) - 1,
        );
        return gate.status === 'wait' && gate.cause !== 'concurrency' ? gate.reason : undefined;
      };
      const executor = new ExecutionRegistry(tree.path).executor(
        selectedExecutor === 'codex'
          ? new CodexCliExecutor({
              operator: config.operator,
              binaryArgs: options.binaryArgs,
              runtimeDirectory: resolveInside(common, 'softwareagents/runtime'),
            })
          : new ClaudeCliExecutor({
              binary: config.operator.binaryPaths?.claude ?? 'claude',
              binaryArgs: options.binaryArgs,
              runtimeDirectory: resolveInside(common, 'softwareagents/runtime'),
            }),
        { metricsOnly: !!options.evaluation, workStore },
      );
      if (interrupted) throw new Error('Worker interrupted');
      {
        let verdict: string | null | undefined;
        try {
          verdict = withMachineAdmission(`${executionId}-spawn`, () => revalidate() ?? null);
        } catch (error) {
          verdict = `spawn revalidation failed: ${(error as Error).message}`;
        }
        if (verdict !== null)
          invalidated =
            verdict ??
            `${selectedExecutor}: runtime admission is busy at spawn; inspect ${executorSlotsDirectory(selectedExecutor)}`;
      }
      if (invalidated) return invalidatedResult(invalidated);
      slot.markLaunching('registered_wrapper');
      telemetry.phase('execution');
      options.evaluation?.settled(undefined, false);
      await lifecycle?.running(cancel);
      handle = executor.start({
        executionId,
        projectId: config.project.id,
        taskKey: args.task,
        role,
        prompt: compiled.context,
        taskData,
        agentSpec: spec,
        flags: [],
        ...(selection?.choice?.model ? { model: selection.choice.model } : {}),
        ...(tierSelection?.choice
          ? {
              tier: tierSelection.tier!,
              model: tierSelection.choice.model,
              effort: tierSelection.choice.effort,
              selectionReason: tierSelection.reason,
            }
          : {}),
        worktreePath: tree.path,
        timeoutMin: options.evaluation?.timeoutMin ?? 30,
        registerProcess: async (pid) => {
          lifecycle?.assertOwned();
          slot!.setExecutionProcess(pid);
          if (lifecycle) await workStore!.setExecutionProcess(executionId, lifecycle.owner, pid);
          audit('executor_started');
        },
        ...(lifecycle
          ? {
              persistProcessClose: async () => {
                lifecycle.assertOwned();
                await workStore!.closeExecution(executionId, lifecycle.owner);
              },
            }
          : {}),
      });
      if (handle.sessionId) {
        slot.setSession(handle.sessionId);
        await workStore?.setExecutionSession(executionId, handle.sessionId);
      }
      exitCode = undefined;
      executionDiagnostic = undefined;
      eventsStarted = true;
      for await (const event of handle.events) {
        if (event.type === 'telemetry') telemetry.observe(event.observation);
        if (
          !options.evaluation &&
          event.type === 'rateLimit' &&
          (!event.capacity || event.message === 'rejected')
        ) {
          const resets =
            event.capacity?.windows.flatMap((window) =>
              window.resetsAt !== null && window.resetsAt > nowSeconds() ? [window.resetsAt] : [],
            ) ?? [];
          if (
            runtimeQuota?.status === 'wait' &&
            runtimeQuota.resetsAt !== null &&
            runtimeQuota.resetsAt > nowSeconds()
          )
            resets.push(runtimeQuota.resetsAt);
          if (event.retryAfterSec > 0) resets.push(nowSeconds() + event.retryAfterSec);
          runtimeQuota = {
            status: 'wait',
            cause: 'quota',
            reason: event.message,
            resetsAt: resets.length ? Math.max(...resets) : null,
          };
          audit('quota_exhausted', { detail: JSON.stringify(runtimeQuota) });
        }
        if (event.type === 'started') {
          try {
            slot.setSession(event.sessionId);
            await workStore?.setExecutionSession(executionId, event.sessionId);
          } catch (error) {
            slotFailure = error;
            try {
              handle.cancel();
            } catch {
              log('Executor cancellation failed; draining events before releasing locks.');
            }
          }
        }
        if (event.type === 'finished') {
          exitCode = event.exitCode;
          if (exitCode !== 0)
            executionDiagnostic = failureDiagnostic(event.resultSummary, exitCode);
          executionFinished = true;
        }
      }
      if (lifecycle && executionFinished)
        await workStore!.closeExecution(executionId, lifecycle.owner);
      if (runtimeQuota) {
        process.exitCode = 3;
        return { branch: tree.branch, commit: null, stat: '', quotaDecision: runtimeQuota };
      }
      telemetry.phase('commit_guards');
      if (slotFailure) throw slotFailure;
      if (verifier) {
        let results: CriterionResult[] = [];
        if (!interrupted && exitCode === 0) {
          const scratch = resolveInside(common, 'softwareagents/runtime/verifiers');
          fs.mkdirSync(scratch, { recursive: true });
          try {
            results = await checkCascadeCriteria(
              verifier,
              base,
              tree.path,
              scratch,
              verifierAbort.signal,
              usingDefaultVerifier ? config.operator.protectedPaths : undefined,
            );
          } catch (error) {
            if (error instanceof EvalIntegrityError) await recordAttempt([], 'criteria_tampered');
            if (error instanceof EvalCriterionTerminationError) {
              verifierClosed = false;
              await recordAttempt([error.result], 'fail');
            }
            throw error;
          }
        }
        const passed =
          !interrupted &&
          exitCode === 0 &&
          results.length > 0 &&
          results.every((r) => r === 'pass');
        await recordAttempt(
          results,
          exitCode === 0 ? (passed ? 'pass' : 'fail') : 'executor_error',
        );
        if (!passed) {
          // Only deterministic verifier failures permit another admitted attempt.
          if (!interrupted && exitCode === 0 && attempt + 1 < levels.length) {
            await telemetry.finish('error');
            options.evaluation?.settled(telemetry.rootSpan, true);
            slot.release();
            slot = undefined;
            resetCascadeWorktree(
              verifier,
              tree.path,
              base,
              usingDefaultVerifier ? config.operator.protectedPaths : undefined,
            );
            escalatedFrom = tierSelection!.tier!;
            attempt++;
            executionId = randomUUID();
            handle = undefined;
            eventsStarted = false;
            executionFinished = false;
            telemetry = undefined;
            attemptRecorded = false;
            continue;
          }
          if (options.evaluation)
            return {
              branch: '',
              commit: null,
              stat: '',
              evaluationSuccess: false,
              evaluationVerifierFailed: !interrupted && exitCode === 0,
            };
          throw new Error('Cascade failed; changes retained for review');
        }
      }
      break;
    }
    if (options.evaluation) {
      if (interrupted) throw new Error('Evaluation interrupted');
      if (git(tree.path, ['rev-parse', 'HEAD']) !== base)
        throw new Error('Evaluation changed Git HEAD');
      telemetryStatus = exitCode === 0 ? 'ok' : 'error';
      return { branch: '', commit: null, stat: '', evaluationSuccess: telemetryStatus === 'ok' };
    }
    lifecycle?.assertOwned();
    audit('commits_checked');
    if (interrupted || exitCode !== 0)
      throw new WorkerExecutionError(
        `Execution failed or was interrupted; changes retained for review (${executionDiagnostic ?? failureDiagnostic(interrupted ? 'interrupted' : '', exitCode)})`,
      );
    if (
      git(tree.path, ['symbolic-ref', '--short', 'HEAD']) !== tree.branch ||
      git(tree.path, ['rev-parse', 'HEAD']) !== base
    )
      throw new Error('Execution changed Git HEAD; refusing runtime commit');
    if (!git(tree.path, ['status', '--porcelain', '--untracked-files=all'])) {
      audit('protected_paths_checked', { detail: 'No changes' });
      telemetryStatus = 'ok';
      audit('no_changes');
      log(`sin cambios\nRama: ${tree.branch}`);
      return { branch: tree.branch, commit: null, stat: '' };
    }
    git(tree.path, ['add', '--all']);
    const gate = guardProtectedPaths({
      cwd: tree.path,
      base,
      staged: true,
      operator: config.operator,
      projectId: config.project.id,
      taskKey: args.task,
      executionId,
    });
    audit('protected_paths_checked', { detail: gate.decision.outcome });
    if (gate.decision.outcome !== 'allow') {
      await lifecycle?.finish('REVIEW', 'Protected paths require review');
      telemetryStatus = gate.decision.outcome === 'require_human' ? 'require_human' : 'error';
      if (gate.decision.outcome === 'require_human') {
        const { openWorkStore } = await import('./workstore/SqliteWorkStore.js');
        const store = await openWorkStore({ repositoryPath: cwd, projectId: config.project.id });
        try {
          if (!store.getTask(args.task))
            store.createTask({
              key: args.task,
              type: 'implementation',
              // The executor has finished; review holds no lease.
              status: 'REVIEW',
              branch: tree.branch,
              worktree_ref: tree.path,
            });
          await new HumanDecisions(store).requireHuman(
            'touch_protected_path',
            'system',
            config.operator.autonomyLevel,
            'Rama: ' + tree.branch + '\nRutas protegidas: ' + gate.paths.join(', '),
            [args.task],
          );
        } finally {
          store.close();
        }
      }
      log('require_human: rutas protegidas: ' + gate.paths.join(', ') + '\nRama: ' + tree.branch);
      return { branch: tree.branch, commit: null, stat: '', policyDecision: gate.decision };
    }
    try {
      git(tree.path, [
        '-c',
        'core.hooksPath=',
        'commit',
        '-m',
        `${workerCommitSubject(args.task, brief)}\n\nSoftwareAgents-Execution: ${executionId}`,
      ]);
    } catch {
      throw new CliUsageError('Runtime Git commit failed; changes retained for review');
    }
    const commit = git(tree.path, ['rev-parse', 'HEAD']);
    const stat = git(tree.path, ['diff', '--stat', base, commit]);
    audit('ready_for_review');
    telemetryStatus = 'ok';
    log(`rama lista para revisión\nRama: ${tree.branch}\nCommit: ${commit}\n${stat}`);
    return { branch: tree.branch, commit, stat };
  } catch (error) {
    telemetryStatus = 'error';
    audit(interrupted ? 'interrupted' : 'failed');
    throw error;
  } finally {
    try {
      try {
        await recordAttempt([], 'executor_error');
      } catch (error) {
        telemetryStatus = 'error';
        throw error;
      } finally {
        await telemetry?.finish(telemetryStatus);
      }
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
      const confirmed = verifierClosed && (!handle || !eventsStarted || executionFinished);
      if (!confirmed) await lifecycle?.retainForRecovery();
      try {
        if (confirmed) {
          try {
            slot?.release();
          } finally {
            release();
          }
        } else log('Lease and executor slot retained: executor termination was not confirmed.');
      } finally {
        options.evaluation?.settled(telemetry?.rootSpan, confirmed);
      }
    }
  }
}
