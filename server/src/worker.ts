import { setTimeout as delay } from 'node:timers/promises';

import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

import * as agentSchema from '../../core/schemas/agent-spec.schema.json';
import type { AgentSpec } from '../../core/src/agentSpec.js';
import type { FeatureSpec } from '../../core/src/featureSpec.js';
import type { CascadeVerifier, ModelTier } from '../../core/src/modelTier.js';
import type { ProjectConfig } from '../../core/src/project.js';
import type { TestReport } from '../../core/src/testReport.js';
import {
  compileAgent,
  executorSupportsRole,
  ROLE_PROFILES,
  TOOL_POLICY_VERSION,
} from './agentCompiler.js';
import { extractJsonObject } from './agentOutput.js';
import {
  architectArtifacts,
  architectBrief,
  architectContext,
  architectPaths,
  type ArchitectProposal,
  type ArchitectRequest,
  architectTaskKey,
  openArchitectDecision,
  validateArchitect,
  writeArchitectArtifacts,
} from './architect.js';
import { type AuditEntry, AuditLog, recordAudit } from './auditLog.js';
import { validateChangeZone } from './changeZones.js';
import { CliUsageError } from './cliErrors.js';
import { readTaskInput, taskPath } from './commands/taskFiles.js';
import { readConfig } from './configPersistence.js';
import {
  CLAUDE_OAUTH_REFRESH_CONTENTION,
  CLAUDE_OAUTH_REFRESH_RETRIES,
  CLAUDE_OAUTH_REFRESH_WAIT_MS,
  REVIEW_MAX_REWORK_ROUNDS,
  VALIDATION_AUDIT_MAX_ERROR_CHARS,
  VALIDATION_AUDIT_MAX_ERRORS,
  VERIFIER_STYLE_RETRIES,
} from './constants.js';
import {
  ChangeZonesExceededError,
  type DeveloperRequest,
  developerRequest,
  developerStyleCommands,
  developerVerifier,
  guardDeveloperChanges,
  isQaAuthorTask,
  MissingTestError,
  resetDeveloperWorktree,
} from './developer.js';
import { DeveloperGuardError, developerGuardFailure } from './developerFailure.js';
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
import { assertTaskDependencies, featureBaseBranch } from './featureRunBase.js';
import { assertDirectRef } from './gitPublication.js';
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
import {
  qaBrief,
  qaCommands,
  qaRequestedCommands,
  qaSelectionReport,
  QaTestSelectionError,
  validateTestReport,
} from './qa.js';
import { readSelectionSnapshot } from './quotaCommand.js';
import { type MachineQuotaPolicy, type QuotaDecision, quotaGate } from './quotaGate.js';
import {
  guardRequirementsWrites,
  nextRequirementsVersion,
  openRequirementsQuestions,
  requirementsBrief,
  requirementsDocPath,
  type RequirementsRequest,
  requirementsSnapshot,
  serializeRequirements,
  validateRequirements,
  writeRequirements,
} from './requirements.js';
import {
  isSuccessfulTaskStep,
  QA_FAILURE_PREFIX,
  REVIEW_FAILURE_PREFIX,
  reviewReworkRounds,
} from './reviewAttempts.js';
import {
  preferCrossExecutor,
  reviewerBrief,
  reviewerDecision,
  type ReviewerRequest,
  reviewerRequest,
  validateReview,
} from './reviewer.js';
import { compileSchema, SchemaValidationError, validateSchema } from './schemaValidation.js';
import { taskBranchBase } from './taskBranchBase.js';
import { taskModelInputs } from './taskModelInputs.js';
import { ExecutionTelemetry, TelemetrySink, type TelemetrySpan } from './telemetry.js';
import {
  styleOnlyFailures,
  type VerifierFailure,
  verifierFailure,
  verifierFailureReason,
} from './verifierFeedback.js';
import {
  isVerifierInfrastructureFailure,
  VERIFIER_INFRASTRUCTURE_PREFIX,
  VerifierInfrastructureError,
} from './verifierInfrastructure.js';
import { WorkerLifecycle } from './workerLifecycle.js';
import { publishWorkerResult } from './workerPublication.js';
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
  /** Trusted feature CLI entry; reuses admission, leases and executor containment. */
  requirements?: RequirementsRequest;
  architect?: ArchitectRequest;
  developer?: DeveloperRequest;
  reviewer?: ReviewerRequest;
  /** QA reuses the read-only Reviewer execution cycle, with a different report/outcome. */
  qa?: boolean;
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
  designErrors?: string[];
  requirementsQuestions?: string[];
  requirementsVersion?: string;
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
      : detail.includes(CLAUDE_OAUTH_REFRESH_CONTENTION)
        ? 'oauth_refresh_contention'
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

// Preserve error identity (including persistence/recovery error codes) while carrying
// the diagnostic from the execution scope, where finished.exitCode is still known.
const workerFailureReasons = new WeakMap<Error, string>();

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
  if (
    options.architect
      ? args.task !== architectTaskKey(options.architect.key)
      : options.requirements
        ? !/^FEAT-\d{3}$/.test(args.task) || options.requirements.key !== args.task
        : options.reviewer
          ? args.task !== options.reviewer.task.key || !/^FEAT-\d{3}-T\d{2}$/.test(args.task)
          : options.developer
            ? args.task !== options.developer.task.key || !/^FEAT-\d{3}-T\d{2}$/.test(args.task)
            : !/^SA-\d{3,}$/.test(args.task)
  )
    throw new CliUsageError('Invalid task key');
  const common = path.resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']));
  const legacyLock = resolveInside(common, `softwareagents/locks/${args.task}.lock`);
  if (fs.existsSync(legacyLock))
    throw new CliUsageError(
      `Task locked: ${legacyLock}. Verify legacy worker and executor have stopped before removing it.`,
    );
  const store = await openWorkStore({ repositoryPath: cwd, projectId: config.project.id });
  const lifecycle = new WorkerLifecycle(store, args.task);
  const developerRetry =
    !!options.developer && store.getTask(args.task)?.status === 'FAILED_RETRYABLE';
  try {
    if (options.reviewer) {
      if (
        JSON.stringify(
          reviewerRequest(
            store,
            config,
            options.reviewer.key,
            args.task,
            undefined,
            options.qa ? 'qa' : 'review',
          ),
        ) !== JSON.stringify(options.reviewer)
      )
        throw new Error(`${options.qa ? 'QA' : 'Reviewer'} context changed`);
    }
    if (options.developer) {
      const current = developerRequest(store, config, options.developer.key, args.task);
      if (JSON.stringify(current) !== JSON.stringify(options.developer))
        throw new Error('Developer context changed');
      if (store.getTask(args.task)?.review_ref)
        throw new Error('Developer task already has a review_ref');
      const record = store.getTask(args.task)!;
      if (
        developerRetry &&
        !isVerifierInfrastructureFailure(record.blocked_reason) &&
        !developerGuardFailure(record.blocked_reason) &&
        record.attempt + 1 >= record.max_attempts
      ) {
        await store.transition(
          record.key,
          record.version,
          'FAILED_FINAL',
          record.blocked_reason ?? 'Developer max_attempts exhausted',
          'operator',
        );
        throw new Error('Developer max_attempts exhausted; FAILED_FINAL requires human review');
      }
    }
    if (options.architect) {
      const existing = store.getTask(args.task);
      if (existing && (existing.agent_role !== 'architect' || existing.type !== 'architecture'))
        throw new CliUsageError('Design task belongs to another workflow');
      if (!existing)
        store.createTask({ key: args.task, type: 'architecture', agent_role: 'architect' });
    }
    if (options.requirements) {
      const existing = store.getTask(args.task);
      if (existing && (existing.agent_role !== 'requirements-analyst' || existing.type !== 'docs'))
        throw new CliUsageError('Feature task belongs to another workflow');
      if (!existing)
        store.createTask({ key: args.task, type: 'docs', agent_role: 'requirements-analyst' });
      if (existing?.status === 'FAILED_RETRYABLE' && !options.requirements.revision)
        await store.transition(
          existing.key,
          existing.version,
          'READY',
          'Explicit Requirements retry',
          'operator',
        );
    }
    // Availability decisions must be re-evaluated by selection before claim.
    if (
      options.requirements?.revision ||
      options.architect?.revision ||
      store.getTask(args.task)?.status !== 'WAITING_HUMAN'
    )
      await lifecycle.claim(
        options.requirements?.revision ?? options.architect?.revision,
        options.reviewer ? (options.qa ? 'qa' : 'review') : false,
      );
    const result = await runWorkerExecution(args, options, lifecycle, config, developerRetry);
    if (result.quotaDecision?.status === 'wait' && !result.availabilityBlock) {
      if (options.reviewer)
        await lifecycle.finish(
          options.qa ? 'QA' : 'REVIEW',
          `${options.qa ? QA_FAILURE_PREFIX : REVIEW_FAILURE_PREFIX}category=${result.quotaDecision.cause ?? 'quota'}; exit_code=unknown`,
        );
      else await lifecycle.wait(result.quotaDecision);
    } else if (!result.availabilityBlock && !result.policyDecision)
      await lifecycle.finish(
        'REVIEW',
        result.commit ? `Runtime commit ${result.commit}` : 'Execution finished without changes',
      );
    if (result.designErrors) {
      await openArchitectDecision(store, options.architect!.key, result.designErrors);
      process.exitCode = 3;
    }
    if (result.requirementsQuestions)
      await openRequirementsQuestions(
        store,
        args.task,
        result.requirementsQuestions,
        result.requirementsVersion,
      );
    return result;
  } catch (error) {
    const executionFailure = error instanceof Error ? workerFailureReasons.get(error) : undefined;
    const guard =
      error instanceof ChangeZonesExceededError ||
      error instanceof MissingTestError ||
      error instanceof DeveloperGuardError;
    const diagnostic = guard ? error.diagnostic() : undefined;
    const history = store.listDomainEvents(args.task);
    // A successful step or an explicit operator reset starts a fresh correction cycle.
    // Looking beyond the last failure also bounds alternating guard violations.
    const reset = history
      .map(
        (event) =>
          isSuccessfulTaskStep(event) ||
          (event.to_status === 'READY' && event.reason !== 'Retry lease'),
      )
      .lastIndexOf(true);
    const repeated =
      !!options.developer &&
      !!diagnostic &&
      history.slice(reset + 1).some((event) => {
        const previous = developerGuardFailure(event.reason);
        return (
          previous?.category === developerGuardFailure(diagnostic)?.category &&
          (!(error instanceof DeveloperGuardError) || previous?.detail === error.message)
        );
      });
    const executorInfrastructure =
      !!options.developer &&
      /category=(spawn|auth|timeout|lease|workspace);/.test(
        executionFailure ?? (error instanceof WorkerExecutionError ? error.message : ''),
      );
    const humanGate = repeated || executorInfrastructure;
    if (humanGate) process.exitCode = 3;
    await lifecycle.finish(
      humanGate
        ? 'WAITING_HUMAN'
        : options.reviewer
          ? options.qa
            ? 'QA'
            : 'REVIEW'
          : 'FAILED_RETRYABLE',
      (options.reviewer ? (options.qa ? QA_FAILURE_PREFIX : REVIEW_FAILURE_PREFIX) : '') +
        (diagnostic
          ? repeated
            ? 'Developer failed: ' +
              JSON.stringify({
                ...developerGuardFailure(diagnostic),
                gate: 'repeated_guard; human review required',
              })
            : diagnostic
          : error instanceof VerifierInfrastructureError
            ? error.message
            : error instanceof EvalCriterionTerminationError
              ? VERIFIER_INFRASTRUCTURE_PREFIX +
                'verifier termination unconfirmed; SA-026 recovery required'
              : error instanceof WorkerExecutionError
                ? error.message
                : (executionFailure ??
                  `Worker failed (${failureDiagnostic(error instanceof Error ? error.message : '')})`)),
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
  developerRetry = false,
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
    (options.reviewer ? reviewerBrief(options.reviewer) : undefined) ??
    (options.developer ? JSON.stringify(options.developer) : undefined) ??
    (options.architect ? architectBrief(options.architect, {}) : undefined) ??
    (options.requirements ? requirementsBrief(options.requirements) : undefined) ??
    options.evaluation?.brief ??
    (args.brief
      ? fs.readFileSync(path.resolve(cwd, args.brief), 'utf8')
      : JSON.stringify(lifecycle?.store.getTask(args.task) ?? { key: args.task }));
  const role =
    (options.reviewer ? (options.qa ? 'qa' : 'reviewer') : undefined) ??
    (options.developer
      ? isQaAuthorTask(options.developer.task)
        ? 'qa-author'
        : 'developer'
      : undefined) ??
    (options.architect ? 'architect' : undefined) ??
    (options.requirements ? 'requirements-analyst' : undefined) ??
    lifecycle?.store.getTask(args.task)?.agent_role ??
    options.evaluation?.agentSpec?.identity.role ??
    'developer';
  if (role === 'qa-author' && !options.developer)
    throw new CliUsageError('QA author requires feature develop with a validated task scope');
  const spec = validateSchema(
    compileSchema<AgentSpec>(agentSchema),
    options.evaluation?.agentSpec ?? loadWorkerAgentSpec(undefined, role),
  );
  const taskData = {
    documentationOnly: options.developer?.task.type === 'doc',
    task: { key: args.task, brief, verifierFailures: [] as VerifierFailure[] },
    brainContents: {} as Record<string, string>,
    repository: {
      projectId: config.project.id,
      ...(options.requirements || options.architect
        ? { brainPath: config.project.brain.path }
        : {}),
    },
  };
  let compiled = compileAgent(spec, role, taskData);
  // Explicit selection only narrows the Operator catalog.
  let tierPolicy =
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
  let modelPolicy =
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
    if (options.reviewer && found.code !== 'code_execution_not_mediated') {
      await lifecycle?.finish(
        options.qa ? 'QA' : 'REVIEW',
        `${options.qa ? QA_FAILURE_PREFIX : REVIEW_FAILURE_PREFIX}category=${found.code}; exit_code=unknown`,
      );
      process.exitCode = 3;
      return {
        branch: '',
        commit: null,
        stat: '',
        availabilityBlock: { code: found.code, decisionId },
        blockedCause: cause,
      };
    }
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
        if (options.reviewer) await lifecycle?.finish(options.qa ? 'QA' : 'REVIEW', found.code);
        else await lifecycle?.idleForDecision(found.code);
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
  let tierIndex = 0;
  let styleRetries = 0;
  let escalatedFrom: ModelTier | undefined;
  let cascade: NonNullable<typeof tierPolicy>['cascade'];
  let verifier: CascadeVerifier | undefined;
  let usingDefaultVerifier = false;
  let levels: ModelTier[] = [];
  let tree: { path: string; branch: string };
  let base: string;
  let startingHead: string;
  let retryPrepared = false;
  let attemptRecorded = false;
  let exitCode: number | undefined;
  let executionDiagnostic: string | undefined;
  let containmentCorrection: string | undefined;
  let guardCorrection: { before: string; executor: string; selection: string } | undefined;
  let correctionPending = false;
  let oauthRefreshContention = false;
  let oauthRefreshRetries = 0;
  let runtimeQuota: QuotaDecision | undefined;
  let requirementsAttempt = 0;
  let requirementsOutput = '';
  let qaEvidence: TestReport['commands'] | undefined;
  let qaRequestsUsed = false;
  let featureSpec: FeatureSpec | undefined;
  let designProposal: ArchitectProposal | undefined;
  let designFiles: Map<string, string> | undefined;
  let designContext: Record<string, string | null> = {};
  let requirementsBefore: Map<string, string> | undefined;
  const featureDoc = options.requirements
    ? requirementsDocPath(config.project.brain.path, options.requirements.key)
    : undefined;
  const recordAttempt = async (
    results: CriterionResult[],
    result: CascadeAttempt['result'],
    reason?: string,
  ) => {
    if (!verifier || !telemetry || !tree || attemptRecorded || !tierSelection?.choice) return;
    const outcome: CascadeAttempt = {
      attempt: attempt + 1,
      escalatedFrom,
      tier: tierSelection.tier!,
      executor: tierSelection.choice.executor,
      model: tierSelection.choice.model,
      verifiers: results,
      result,
      exitCode: exitCode ?? null,
      ...(reason ? { reason } : {}),
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
  const probed: ('claude' | 'codex')[] = (
    options.evaluation && !options.evaluation.cascadeTask
      ? [options.evaluation.executor]
      : tierPolicy || modelPolicy
        ? (['claude', 'codex'] as const).filter((id) =>
            config.operator.allowedExecutors.includes(id),
          )
        : config.operator.allowedExecutors.includes(args.executor ?? 'claude')
          ? [args.executor ?? 'claude']
          : []
  ).filter((id) => executorSupportsRole(id, role));
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
      !options.requirements &&
      !options.architect &&
      !options.reviewer &&
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
    if (options.developer && !verifier) {
      verifier = developerVerifier(config, args.task);
      usingDefaultVerifier = !verifier.allowedPaths;
      // Mandatory final checks without enabling model escalation.
      levels = [];
    }
    if (options.evaluation?.cascadeTask && !verifier)
      throw new CliUsageError(
        'Cascade eval requires an enabled, eligible Operator verifier binding',
      );
    if (options.developer?.task.type === 'doc') {
      // Documentation bypasses execution/type verifiers, including Operator overrides.
      verifier = { ...verifier, commands: [] };
      usingDefaultVerifier = !verifier.allowedPaths;
      levels = [];
    }
    for (;;) {
      const inputs: TierInputs =
        verifier && levels.length ? { cascadeTier: levels[tierIndex] } : normalInputs;
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
              if (options.reviewer) {
                const snapshot = { ...readSelectionSnapshot(config.operator), availability };
                tierPolicy = {
                  ...tierPolicy!,
                  tiers: Object.fromEntries(
                    Object.entries(tierPolicy!.tiers).map(([tier, value]) => [
                      tier,
                      {
                        ...value!,
                        candidates: preferCrossExecutor(
                          value!.candidates,
                          options.reviewer!.developerExecutor,
                          snapshot,
                          tier as ModelTier,
                        ),
                      },
                    ]),
                  ),
                };
              }
              validateModelTierSupport(
                tierPolicy!,
                config.operator.binaryPaths?.claude,
                spec,
                tierRule,
                inputs,
                probed.filter((id) => !launchBlock(availability?.[id], nowSeconds())),
                config.operator.executorLevels,
                config.operator.executors?.claude?.configDir,
              );
              return admitModelTier(
                spec,
                tierRule,
                tierPolicy!,
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
              if (options.reviewer)
                modelPolicy = Object.fromEntries(
                  Object.entries(modelPolicy).map(([capability, choices]) => [
                    capability,
                    preferCrossExecutor(choices, options.reviewer!.developerExecutor, snapshot),
                  ]),
                );
              selection = selectExecutor(spec, modelPolicy, snapshot);
              // The fresh decision, not the pre-admission preview, owns the slot.
              if (selection.choice) selectedExecutor = selection.choice.executor;
              legacyBlock = selection.block;
            }
            // Legacy manual runs retain conservative defaults for pre-quota configs.
            if (!modelPolicy) {
              legacyMachinePolicy(snapshot, selectedExecutor);
              const excluded = excludeCandidate(selectedExecutor, snapshot, undefined, role);
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
      const reviewSelection = options.reviewer
        ? {
            developer: options.reviewer.developerExecutor,
            outcome:
              selectedExecutor !== options.reviewer.developerExecutor
                ? 'cross_executor'
                : 'same_executor_no_available_alternative',
          }
        : undefined;
      if (
        correctionPending &&
        guardCorrection &&
        (selectedExecutor !== guardCorrection.executor ||
          JSON.stringify(tierSelection?.choice ?? selection?.choice ?? null) !==
            guardCorrection.selection)
      )
        throw new DeveloperGuardError(
          'Guard correction requires the same executor/model; retry admission later',
        );
      if (reviewSelection)
        audit('review_executor_selected', {
          executor: selectedExecutor,
          detail: JSON.stringify(reviewSelection),
        });
      const selectionReason = `${options.reviewer ? `${role}: excluded codex: code_execution_not_mediated; ` : ''}${reviewSelection ? `${options.qa ? 'QA' : 'Reviewer'} ${reviewSelection.outcome}; developer=${reviewSelection.developer}; ` : ''}${tierSelection?.reason ?? selection?.reason ?? `Explicit worker: ${selectedExecutor}`}`;
      if (tierSelection && reviewSelection) tierSelection.reason = selectionReason;
      if (selection && reviewSelection) selection.reason = selectionReason;
      telemetry = new ExecutionTelemetry(
        new TelemetrySink(common, config.project.id, config.operator.telemetry),
        {
          executionId,
          taskKey: args.task,
          executor: selectedExecutor,
          agent: spec.metadata.id,
          role,
          ...(reviewSelection ? { review: reviewSelection } : {}),
          model: tierSelection?.choice?.model ?? selection?.choice?.model,
          tier: tierSelection?.tier ?? undefined,
          effort: tierSelection?.choice?.effort,
          ...(verifier ? { cascade: { attempt: attempt + 1, escalatedFrom } } : {}),
        },
        attempt ? Date.now() : telemetryStart,
      );
      await lifecycle?.claim(undefined, options.reviewer ? (options.qa ? 'qa' : 'review') : false);
      if (workStore) {
        if (!workStore.getTask(args.task))
          workStore.createTask({ key: args.task, type: 'unknown', status: 'DRAFT' });
        await workStore.createExecution({
          key: executionId,
          task_key: args.task,
          agent_template_version: spec.metadata.version,
          executor: selectedExecutor,
          agent_role: role,
          model_id: tierSelection?.choice?.model ?? selection?.choice?.model ?? '',
          model_tier: tierSelection?.tier,
          model_effort: tierSelection?.choice?.effort ?? null,
          selection_reason: selectionReason,
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
      tree ??= options.reviewer
        ? { path: options.reviewer.worktree, branch: options.reviewer.reviewRef.branch }
        : options.evaluation
          ? { path: options.evaluation.worktreePath, branch: '' }
          : await new WorktreeManager({
              repositoryPath: cwd,
              defaultBranch: options.developer
                ? featureBaseBranch(workStore!, config, options.developer.key)
                : config.project.repo.defaultBranch,
              manualPreparation: true,
              trustedBase: !!options.developer,
            }).create(
              options.architect?.key ?? args.task,
              options.developer ? 'developer' : 'worker',
            );
      if (options.developer) assertDirectRef(cwd, `refs/heads/${tree.branch}`);
      base ??= options.developer
        ? taskBranchBase(
            cwd,
            tree.branch,
            featureBaseBranch(workStore!, config, options.developer!.key),
          )
        : git(tree.path, ['rev-parse', 'HEAD']);
      if (developerRetry && !retryPrepared && workStore!.getTask(args.task)!.worktree_ref) {
        lifecycle!.assertOwned();
        resetDeveloperWorktree(
          workStore!,
          workStore!.getTask(args.task)!,
          config,
          tree.path,
          tree.branch,
          base,
        );
        audit('developer_retry_reset');
      }
      retryPrepared = true;
      if (!correctionPending && git(tree.path, ['status', '--porcelain', '--untracked-files=all']))
        throw new Error('Existing task worktree is dirty; review it before retrying');
      startingHead ??= git(tree.path, ['rev-parse', 'HEAD']);
      if (
        options.reviewer &&
        JSON.stringify(
          reviewerRequest(
            workStore!,
            config,
            options.reviewer.key,
            args.task,
            lifecycle!.owner,
            options.qa ? 'qa' : 'review',
          ),
        ) !== JSON.stringify(options.reviewer)
      )
        throw new Error(`${options.qa ? 'QA' : 'Reviewer'} context changed before launch`);
      if (options.developer) {
        assertTaskDependencies(workStore!, cwd, args.task, git(tree.path, ['rev-parse', 'HEAD']));
        const current = developerRequest(
          workStore!,
          config,
          options.developer.key,
          args.task,
          lifecycle!.owner,
        );
        if (JSON.stringify(current) !== JSON.stringify(options.developer))
          throw new Error('Developer context changed before launch');
        for (const zone of [
          ...options.developer.task.changeZones!,
          ...(options.developer.task.testZones ?? []),
        ]) {
          // Physical containment is checked again in the actual task checkout.
          validateChangeZone(tree.path, zone, config.operator.protectedPaths ?? []);
        }
      }
      if (options.requirements?.revision && base !== options.requirements.revision.gitSha)
        throw new Error('Feature SHA changed before Requirements revision');
      if (options.architect) {
        const input = options.architect;
        const approved = workStore!.getFeature(input.key);
        if (
          approved?.status !== 'approved' ||
          approved.git_sha !== input.gitSha ||
          base !== input.gitSha
        )
          throw new Error('Approved FeatureSpec SHA changed before Architect launch');
        const relative = requirementsDocPath(config.project.brain.path, input.key);
        if (
          git(tree.path, ['show', input.gitSha + ':' + relative]) !==
          readTaskInput(tree.path, relative).trim()
        )
          throw new Error('Approved FeatureSpec file changed before Architect launch');
        designContext = architectContext(tree.path, config.project.brain.path);
        taskData.brainContents = Object.fromEntries(
          Object.entries(designContext).filter(
            (entry): entry is [string, string] => entry[1] !== null,
          ),
        );
        if (requirementsAttempt === 0) taskData.task.brief = architectBrief(input, designContext);
        compiled = compileAgent(spec, role, taskData);
      }
      if (options.requirements || options.architect || options.reviewer)
        requirementsBefore ??= requirementsSnapshot(tree.path);
      if (options.qa && !qaEvidence) {
        try {
          qaEvidence = await qaCommands(
            options.reviewer!,
            resolveInside(common, 'softwareagents/runtime/verifiers'),
            verifierAbort.signal,
            undefined,
            (command) =>
              audit('qa_baseline', {
                detail: JSON.stringify({ base: options.reviewer!.reviewRef.base, ...command }),
              }),
          );
          guardRequirementsWrites(tree.path, requirementsBefore!);
          taskData.task.brief = qaBrief(options.reviewer!, qaEvidence);
          compiled = compileAgent(spec, role, taskData);
        } catch (error) {
          if (!(error instanceof QaTestSelectionError)) throw error;
          // Registration already happened; no process has been launched, so closure is certain.
          await workStore!.closeExecution(executionId, lifecycle!.owner);
          const report = qaSelectionReport(options.reviewer!, error);
          const capped =
            reviewReworkRounds(workStore!.getTask(args.task)!) >= REVIEW_MAX_REWORK_ROUNDS;
          const artifact = resolveInside(
            common,
            'softwareagents/brain/test-reports/' + args.task + '/' + executionId + '.json',
          );
          const record = {
            execution_id: executionId,
            review_ref: options.reviewer!.reviewRef,
            report,
            artifact_path: artifact,
          };
          await lifecycle!.completeReview(() =>
            workStore!.completeQa(
              args.task,
              lifecycle!.owner,
              record,
              () => {
                guardRequirementsWrites(tree.path, requirementsBefore!);
                if (
                  JSON.stringify(
                    reviewerRequest(
                      workStore!,
                      config,
                      options.reviewer!.key,
                      args.task,
                      lifecycle!.owner,
                      'qa',
                    ),
                  ) !== JSON.stringify(options.reviewer)
                )
                  throw new Error('QA SHA/context changed before runtime report persistence');
                audit('test_report_pending', { detail: JSON.stringify(record) });
                fs.mkdirSync(path.dirname(artifact), { recursive: true });
                fs.writeFileSync(artifact, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
              },
              capped
                ? { ...reviewerDecision(args.task, 'rework_limit'), requestedBy: 'qa' }
                : undefined,
            ),
          );
          audit('test_report_persisted', { detail: JSON.stringify(record) });
          telemetryStatus = capped ? 'require_human' : 'ok';
          if (capped) process.exitCode = 3;
          log(args.task + ': fail -> ' + workStore!.getTask(args.task)!.status);
          return { branch: tree.branch, commit: null, stat: '' };
        }
      }
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
              configDir: config.operator.executors?.claude?.configDir,
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
      requirementsOutput = '';
      executionDiagnostic = undefined;
      containmentCorrection = undefined;
      oauthRefreshContention = false;
      eventsStarted = true;
      for await (const event of handle.events) {
        if (event.type === 'guardCorrection') containmentCorrection = event.diagnostic;
        if (
          selectedExecutor === 'claude' &&
          ((event.type === 'output' && event.text.includes(CLAUDE_OAUTH_REFRESH_CONTENTION)) ||
            (event.type === 'finished' &&
              event.resultSummary.includes(CLAUDE_OAUTH_REFRESH_CONTENTION)))
        )
          oauthRefreshContention = true;
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
          if ((options.requirements || options.architect || options.reviewer) && exitCode === 0)
            requirementsOutput = extractJsonObject(event.resultSummary);
          if (exitCode !== 0)
            executionDiagnostic = failureDiagnostic(event.resultSummary, exitCode);
          executionFinished = true;
        }
      }
      if (lifecycle && executionFinished)
        await workStore!.closeExecution(executionId, lifecycle.owner);
      if (
        oauthRefreshContention &&
        exitCode !== 0 &&
        /category=(executor|auth);/.test(executionDiagnostic ?? '')
      )
        executionDiagnostic = failureDiagnostic(CLAUDE_OAUTH_REFRESH_CONTENTION, exitCode);
      if (options.requirements || options.architect || options.reviewer)
        guardRequirementsWrites(tree.path, requirementsBefore!);
      if (runtimeQuota) {
        process.exitCode = 3;
        return { branch: tree.branch, commit: null, stat: '', quotaDecision: runtimeQuota };
      }
      telemetry.phase('commit_guards');
      if (slotFailure) throw slotFailure;
      if (
        !interrupted &&
        executionFinished &&
        exitCode !== 0 &&
        oauthRefreshContention &&
        oauthRefreshRetries < CLAUDE_OAUTH_REFRESH_RETRIES &&
        executionDiagnostic?.includes('category=oauth_refresh_contention;')
      ) {
        // A credential failure must leave a pristine workspace before any relaunch.
        if (
          git(tree.path, ['rev-parse', 'HEAD']) !== startingHead ||
          (tree.branch && git(tree.path, ['symbolic-ref', '--short', 'HEAD']) !== tree.branch) ||
          git(tree.path, ['status', '--porcelain', '--untracked-files=all'])
        )
          throw new Error('OAuth contention left workspace changes; review before retrying');
        oauthRefreshRetries++;
        audit('oauth_refresh_wait', {
          attempt: oauthRefreshRetries,
          detail: JSON.stringify({ waitMs: CLAUDE_OAUTH_REFRESH_WAIT_MS }),
        });
        await telemetry!.finish('error');
        slot.release();
        slot = undefined;
        handle = undefined;
        eventsStarted = false;
        executionFinished = false;
        telemetry = undefined;
        log('Claude OAuth refresh contention; waiting before a fresh admission');
        try {
          await delay(CLAUDE_OAUTH_REFRESH_WAIT_MS, undefined, { signal: verifierAbort.signal });
        } catch {
          throw new WorkerExecutionError(
            `Execution interrupted (${failureDiagnostic('cancelled')})`,
          );
        }
        lifecycle?.assertOwned();
        audit('oauth_refresh_retry', { attempt: oauthRefreshRetries });
        executionId = randomUUID();
        continue;
      }
      if (options.requirements || options.architect || options.reviewer) {
        guardRequirementsWrites(tree.path, requirementsBefore!);
        if (
          git(tree.path, ['rev-parse', 'HEAD']) !== base ||
          git(tree.path, ['symbolic-ref', '--short', 'HEAD']) !== tree.branch
        )
          throw new Error('Requirements containment: Git HEAD changed');
        if (!interrupted && exitCode === 0) {
          try {
            if (options.qa) {
              const requested = qaRequestedCommands(
                requirementsOutput,
                qaEvidence!,
                qaRequestsUsed,
              );
              if (requested) {
                qaRequestsUsed = true;
                qaEvidence!.push(
                  ...(await qaCommands(
                    options.reviewer!,
                    resolveInside(common, 'softwareagents/runtime/verifiers'),
                    verifierAbort.signal,
                    requested,
                    (command) =>
                      audit('qa_baseline', {
                        detail: JSON.stringify({
                          base: options.reviewer!.reviewRef.base,
                          ...command,
                        }),
                      }),
                  )),
                );
                guardRequirementsWrites(tree.path, requirementsBefore!);
                taskData.task.brief = qaBrief(options.reviewer!, qaEvidence!, [], true);
                compiled = compileAgent(spec, role, taskData);
                await telemetry.finish('ok');
                slot!.release();
                slot = undefined;
                executionId = randomUUID();
                handle = undefined;
                eventsStarted = false;
                executionFinished = false;
                telemetry = undefined;
                continue;
              }
              const report = validateTestReport(requirementsOutput, options.reviewer!, qaEvidence!);
              const capped =
                report.verdict === 'fail' &&
                reviewReworkRounds(workStore!.getTask(args.task)!) >= REVIEW_MAX_REWORK_ROUNDS;
              const artifact = resolveInside(
                common,
                'softwareagents/brain/test-reports/' + args.task + '/' + executionId + '.json',
              );
              const record = {
                execution_id: executionId,
                review_ref: options.reviewer!.reviewRef,
                report,
                artifact_path: artifact,
              };
              await lifecycle!.completeReview(() =>
                workStore!.completeQa(
                  args.task,
                  lifecycle!.owner,
                  record,
                  () => {
                    guardRequirementsWrites(tree.path, requirementsBefore!);
                    if (
                      JSON.stringify(
                        reviewerRequest(
                          workStore!,
                          config,
                          options.reviewer!.key,
                          args.task,
                          lifecycle!.owner,
                          'qa',
                        ),
                      ) !== JSON.stringify(options.reviewer)
                    )
                      throw new Error('QA SHA/context changed before report persistence');
                    audit('test_report_pending', { detail: JSON.stringify(record) });
                    fs.mkdirSync(path.dirname(artifact), { recursive: true });
                    fs.writeFileSync(artifact, JSON.stringify(record, null, 2) + '\n', {
                      flag: 'wx',
                    });
                  },
                  capped
                    ? { ...reviewerDecision(args.task, 'rework_limit'), requestedBy: 'qa' }
                    : undefined,
                ),
              );
              audit('test_report_persisted', { detail: JSON.stringify(record) });
              telemetryStatus = capped ? 'require_human' : 'ok';
              if (capped) process.exitCode = 3;
              log(
                args.task + ': ' + report.verdict + ' -> ' + workStore!.getTask(args.task)!.status,
              );
              return { branch: tree.branch, commit: null, stat: '' };
            } else if (options.reviewer) {
              const report = validateReview(requirementsOutput, options.reviewer);
              const rounds = reviewReworkRounds(workStore!.getTask(args.task)!);
              const capped =
                report.verdict === 'request_changes' && rounds >= REVIEW_MAX_REWORK_ROUNDS;
              const review = {
                execution_id: executionId,
                review_ref: options.reviewer.reviewRef,
                developer_executor: options.reviewer.developerExecutor,
                reviewer_executor: selectedExecutor,
                report,
              };
              await lifecycle!.completeReview(() =>
                workStore!.completeReview(
                  args.task,
                  lifecycle!.owner,
                  review,
                  () => {
                    guardRequirementsWrites(tree.path, requirementsBefore!);
                    if (
                      JSON.stringify(
                        reviewerRequest(
                          workStore!,
                          config,
                          options.reviewer!.key,
                          args.task,
                          lifecycle!.owner,
                        ),
                      ) !== JSON.stringify(options.reviewer)
                    )
                      throw new Error('Reviewer SHA/context changed before report persistence');
                    audit('review_report_pending', { detail: JSON.stringify(review) });
                  },
                  capped ? reviewerDecision(args.task, 'rework_limit') : undefined,
                ),
              );
              audit('review_report_persisted', { detail: JSON.stringify(review) });
              if (options.reviewer.task.type === 'doc' && report.verdict === 'approve')
                audit('qa_not_applicable', { detail: 'QA no aplicable: tarea doc' });
              telemetryStatus = capped ? 'require_human' : 'ok';
              if (capped) process.exitCode = 3;
              log(`${args.task}: ${report.verdict} → ${workStore!.getTask(args.task)!.status}`);
              return { branch: tree.branch, commit: null, stat: '' };
            } else if (options.architect) {
              designProposal = validateArchitect(requirementsOutput, options.architect.spec, {
                cwd: tree.path,
                protectedPaths: config.operator.protectedPaths,
              });
              if (!workStore) throw new Error('Architect requires a persistent WorkStore');
              designFiles = await architectArtifacts(
                tree.path,
                config.project.brain.path,
                options.architect.key,
                designProposal,
                workStore,
              );
            } else featureSpec = validateRequirements(requirementsOutput, args.task);
            if (
              options.requirements?.revision &&
              featureSpec!.version !==
                nextRequirementsVersion(options.requirements.revision.spec.version)
            )
              throw new SchemaValidationError([
                '/version: must match the next Requirements version',
              ]);
          } catch (error) {
            if (!(error instanceof SchemaValidationError)) throw error;
            audit(
              options.qa
                ? 'qa_validation_failed'
                : options.reviewer
                  ? 'review_validation_failed'
                  : options.architect
                    ? 'design_validation_failed'
                    : 'featurespec_validation_failed',
              {
                attempt: requirementsAttempt + 1,
                // The open decision keeps its first text; the latest errors live here.
                errors: error.errors
                  .slice(0, VALIDATION_AUDIT_MAX_ERRORS)
                  .map((e) => e.slice(0, VALIDATION_AUDIT_MAX_ERROR_CHARS)),
              },
            );
            if (requirementsAttempt++ === 0) {
              taskData.task.brief = options.qa
                ? qaBrief(options.reviewer!, qaEvidence!, error.errors, qaRequestsUsed)
                : options.reviewer
                  ? reviewerBrief(options.reviewer, error.errors)
                  : options.architect
                    ? architectBrief(options.architect, designContext, error.errors)
                    : requirementsBrief(options.requirements!, error.errors);
              compiled = compileAgent(spec, role, taskData);
              await telemetry!.finish('error');
              slot!.release();
              slot = undefined;
              executionId = randomUUID();
              handle = undefined;
              eventsStarted = false;
              executionFinished = false;
              telemetry = undefined;
              continue;
            }
            if (options.reviewer) {
              // Preserve the reviewed SHA and release the lease before opening the existing human gate.
              await lifecycle!.finish(
                options.qa ? 'QA' : 'REVIEW',
                `${options.qa ? QA_FAILURE_PREFIX : REVIEW_FAILURE_PREFIX}category=invalid_report; exit_code=0`,
              );
              telemetryStatus = 'error';
              process.exitCode = 3;
              return { branch: tree.branch, commit: null, stat: '' };
            }
            if (options.architect)
              return { branch: tree.branch, commit: null, stat: '', designErrors: error.errors };
            throw new WorkerExecutionError(
              'FeatureSpec validation failed after two attempts; schema or Requirements contract invalid',
            );
          }
          lifecycle?.assertOwned();
          const draftFeature = options.architect?.key ?? options.requirements?.key;
          if (
            draftFeature &&
            workStore?.getFeatureRun(draftFeature) &&
            !options.requirements?.revision &&
            !options.architect?.revision
          ) {
            const paths = architectPaths(config.project.brain.path, draftFeature);
            const files =
              designFiles ?? new Map([[featureDoc!, serializeRequirements(featureSpec!)]]);
            for (const relative of files.keys())
              if (fs.existsSync(taskPath(tree.path, relative)))
                throw new Error('Runtime artifact already exists without registration');
            await workStore.prepareWorkerPublication(
              {
                feature: draftFeature,
                task: args.task,
                execution: executionId,
                branch: tree.branch,
                worktree: tree.path,
                before: startingHead!,
                sha: startingHead!,
                base,
                tree: git(tree.path, ['rev-parse', `${startingHead}^{tree}`]),
                ...(featureSpec ? { spec: featureSpec } : {}),
                ...(options.architect
                  ? {
                      design: {
                        record: {
                          feature_key: draftFeature,
                          doc_path: paths.doc,
                          dag_path: paths.dag,
                          git_sha: startingHead!,
                          feature_sha: options.architect.gitSha,
                        },
                        dag: designProposal!.dag,
                      },
                    }
                  : {}),
                draft: {
                  files: Object.fromEntries(files),
                  snapshot: [...requirementsBefore!],
                  subject: `feat(${draftFeature}): proponer ${options.architect ? 'diseño técnico' : 'requisitos'}`,
                },
              },
              lifecycle!.owner,
            );
          }
          if (options.architect) writeArchitectArtifacts(tree.path, designFiles!);
          else
            writeRequirements(
              tree.path,
              featureDoc!,
              featureSpec!,
              options.requirements!.revision?.spec,
            );
          guardRequirementsWrites(
            tree.path,
            requirementsBefore!,
            designFiles ? [...designFiles.keys()] : featureDoc!,
          );
        }
      }
      // One free correction on the same tree, before any verifier or cascade accounting.
      // Containment itself still stops Codex; Claude continues after its hook denial.
      let developerTests: string[] | undefined;
      if (options.developer && !interrupted && executionFinished) {
        let rejection:
          ChangeZonesExceededError | MissingTestError | DeveloperGuardError | undefined;
        if (exitCode !== 0 && containmentCorrection)
          rejection = new DeveloperGuardError(containmentCorrection);
        else if (exitCode === 0) {
          try {
            developerTests = guardDeveloperChanges(
              options.developer,
              config,
              tree.path,
              base,
              startingHead,
            );
          } catch (error) {
            if (!(
              error instanceof ChangeZonesExceededError ||
              error instanceof MissingTestError ||
              error instanceof DeveloperGuardError
            ))
              throw error;
            rejection = error;
          }
        }
        if (guardCorrection && correctionPending) {
          audit('guard_correction', {
            detail: JSON.stringify({
              before: guardCorrection.before,
              after: rejection?.diagnostic() ?? (exitCode === 0 ? 'pass' : executionDiagnostic),
              phase: 'after',
            }),
          });
          correctionPending = false;
        }
        if (rejection) {
          if (guardCorrection) throw rejection;
          // Never relaunch over changed Git identity or an unconfirmed process close.
          if (
            git(tree.path, ['rev-parse', 'HEAD']) !== startingHead ||
            git(tree.path, ['symbolic-ref', '--short', 'HEAD']) !== tree.branch
          )
            throw rejection;
          guardCorrection = {
            before: rejection.diagnostic(),
            executor: selectedExecutor,
            selection: JSON.stringify(tierSelection?.choice ?? selection?.choice ?? null),
          };
          correctionPending = true;
          const diagnostic = {
            ...JSON.parse(rejection.diagnostic().slice('Developer failed: '.length)),
            detail: rejection.message,
            action:
              'Correct only the rejected changes on this same tree. Respect allowedScope/changeZones. Move tests to executed test roots, remove temporary directories/nested .git you created, use os.tmpdir() for fixtures, and use apply_patch/Edit for file writes. Never bypass containment or modify protected paths.',
          };
          taskData.task.brief = JSON.stringify({
            ...JSON.parse(taskData.task.brief),
            guardCorrection: diagnostic,
          });
          compiled = compileAgent(spec, role, taskData);
          audit('guard_correction', {
            detail: JSON.stringify({
              before: guardCorrection.before,
              after: 'pending',
              phase: 'before',
            }),
          });
          await telemetry!.finish('error');
          slot!.release();
          slot = undefined;
          executionId = randomUUID();
          handle = undefined;
          eventsStarted = false;
          executionFinished = false;
          telemetry = undefined;
          continue;
        }
      }
      if (verifier) {
        let results: CriterionResult[] = [];
        const failures: VerifierFailure[] = [];
        if (!interrupted && exitCode === 0) {
          const scratch = resolveInside(common, 'softwareagents/runtime/verifiers');
          fs.mkdirSync(scratch, { recursive: true });
          try {
            results = await checkCascadeCriteria(
              options.developer
                ? {
                    ...verifier,
                    commands: [...verifier.commands, ...developerStyleCommands(tree.path, base)],
                  }
                : verifier,
              base,
              tree.path,
              scratch,
              verifierAbort.signal,
              usingDefaultVerifier ? config.operator.protectedPaths : undefined,
              options.developer?.task.type === 'doc' ? undefined : developerTests,
              startingHead,
              {
                failures,
                ...(options.developer
                  ? {
                      autoFix: () => {
                        guardDeveloperChanges(
                          options.developer!,
                          config,
                          tree.path,
                          base,
                          startingHead,
                        );
                      },
                    }
                  : {}),
              },
            );
            if (options.developer)
              guardDeveloperChanges(options.developer, config, tree.path, base, startingHead);
          } catch (error) {
            if (error instanceof EvalCriterionTerminationError) {
              verifierClosed = false;
            }
            throw error;
          }
        }
        const passed =
          !interrupted &&
          exitCode === 0 &&
          (results.length > 0 || options.developer?.task.type === 'doc') &&
          results.every(
            (r) =>
              r === 'pass' ||
              (r === 'not_tested' && !!options.developer && isQaAuthorTask(options.developer.task)),
          );
        await recordAttempt(
          results,
          exitCode === 0 ? (passed ? 'pass' : 'fail') : 'executor_error',
          passed
            ? undefined
            : exitCode !== 0
              ? (executionDiagnostic ?? failureDiagnostic('', exitCode))
              : failures.length
                ? verifierFailureReason(failures)
                : 'verifier_failed: no passing criteria',
        );
        if (!passed) {
          // Only deterministic verifier failures permit another admitted attempt.
          const styleOnly = styleOnlyFailures(failures);
          const retryStyle = styleOnly && styleRetries < VERIFIER_STYLE_RETRIES;
          const escalateModel = !styleOnly && failures.length > 0 && tierIndex + 1 < levels.length;
          if (!interrupted && exitCode === 0 && (retryStyle || escalateModel)) {
            await telemetry!.finish('error');
            options.evaluation?.settled(telemetry.rootSpan, true);
            slot.release();
            slot = undefined;
            resetCascadeWorktree(
              verifier,
              tree.path,
              base,
              usingDefaultVerifier ? config.operator.protectedPaths : undefined,
              options.developer
                ? guardDeveloperChanges(options.developer, config, tree.path, base, startingHead)
                : undefined,
              startingHead,
            );
            escalatedFrom = escalateModel ? tierSelection!.tier! : undefined;
            if (escalateModel) {
              tierIndex++;
              styleRetries = 0;
            } else styleRetries++;
            taskData.task.verifierFailures = failures;
            compiled = compileAgent(spec, role, taskData);
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
          if (exitCode !== 0)
            throw new WorkerExecutionError(
              `${options.developer ? 'Execution failed' : 'Cascade failed'} (${executionDiagnostic ?? failureDiagnostic('', exitCode)})`,
            );
          throw new WorkerExecutionError(
            (options.developer
              ? 'Developer verifier failed; changes retained for review'
              : 'Cascade failed; changes retained for review') +
              (failures.length ? ` (${verifierFailureReason(failures)})` : ''),
          );
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
      git(tree.path, ['rev-parse', 'HEAD']) !== startingHead
    )
      throw new Error('Execution changed Git HEAD; refusing runtime commit');
    if (options.developer)
      guardDeveloperChanges(options.developer, config, tree.path, base, startingHead);
    if (!git(tree.path, ['status', '--porcelain', '--untracked-files=all'])) {
      if (options.developer && workStore!.getTask(args.task)!.review_reports?.length)
        throw new WorkerExecutionError(
          'Developer rework produced no changes; findings remain unresolved',
        );
      audit('protected_paths_checked', { detail: 'No changes' });
      telemetryStatus = 'ok';
      audit('no_changes');
      log(`sin cambios\nRama: ${tree.branch}`);
      return { branch: tree.branch, commit: null, stat: '' };
    }
    git(tree.path, ['add', '--all']);
    if (options.developer)
      guardDeveloperChanges(options.developer, config, tree.path, base, startingHead);
    if (options.requirements || options.architect) {
      const allowed = designFiles ? [...designFiles.keys()] : [featureDoc!];
      guardRequirementsWrites(tree.path, requirementsBefore!, allowed);
      const staged = git(tree.path, ['diff', '--cached', '--name-only', '-z', base])
        .split('\0')
        .filter(Boolean);
      if (staged.length !== allowed.length || staged.some((file) => !allowed.includes(file)))
        throw new Error('Requirements containment: staged paths exceed the FeatureSpec artifact');
    }
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
    const orchestratedFeature =
      options.developer?.key ?? options.architect?.key ?? options.requirements?.key;
    if (
      orchestratedFeature &&
      workStore?.getFeatureRun(orchestratedFeature) &&
      !options.requirements?.revision &&
      !options.architect?.revision
    ) {
      lifecycle!.assertOwned();
      const treeHash = git(tree.path, ['write-tree']);
      const subject = options.developer
        ? workerCommitSubject(args.task, options.developer.task.title.toLowerCase())
        : `feat(${orchestratedFeature}): proponer ${options.architect ? 'diseño técnico' : 'requisitos'}`;
      const sha = execFileSync(
        'git',
        ['-c', 'commit.gpgSign=false', 'commit-tree', treeHash, '-p', startingHead!],
        {
          cwd: tree.path,
          input: `${subject}\n\nSoftwareAgents-Execution: ${executionId}\n`,
          encoding: 'utf8',
          windowsHide: true,
        },
      ).trim();
      const paths = architectPaths(config.project.brain.path, orchestratedFeature);
      const publication = {
        feature: orchestratedFeature,
        task: args.task,
        execution: executionId,
        branch: tree.branch,
        worktree: tree.path,
        before: startingHead!,
        sha,
        base,
        tree: treeHash,
        ...(options.developer ? { developer: true } : {}),
        ...(featureSpec ? { spec: featureSpec } : {}),
        ...(options.architect
          ? {
              design: {
                record: {
                  feature_key: orchestratedFeature,
                  doc_path: paths.doc,
                  dag_path: paths.dag,
                  git_sha: sha,
                  feature_sha: options.architect.gitSha,
                },
                dag: designProposal!.dag,
              },
            }
          : {}),
      };
      await workStore.prepareWorkerPublication(publication, lifecycle!.owner);
      await publishWorkerResult(workStore, config, publication, lifecycle!);
      const stat = git(tree.path, ['diff', '--stat', base, sha]);
      audit('ready_for_review');
      telemetryStatus = 'ok';
      log(`rama lista para revisión\nRama: ${tree.branch}\nCommit: ${sha}\n${stat}`);
      return { branch: tree.branch, commit: sha, stat };
    }
    const commitChanges = () => {
      git(tree.path, [
        '-c',
        'core.hooksPath=',
        'commit',
        '-m',
        `${options.developer ? workerCommitSubject(args.task, options.developer.task.title.toLowerCase()) : options.architect ? `feat(${options.architect.key}): proponer dise?o t?cnico` : options.requirements ? `feat(${args.task}): proponer requisitos` : workerCommitSubject(args.task, brief)}\n\nSoftwareAgents-Execution: ${executionId}`,
      ]);
      return git(tree.path, ['rev-parse', 'HEAD']);
    };
    let commit: string;
    try {
      commit = options.developer
        ? await workStore!.withIdempotency(
            `developer-commit/${args.task}/${options.developer.designSha}${workStore!.getTask(args.task)!.review_reports?.length ? `/rework-${workStore!.getTask(args.task)!.attempt}` : ''}`,
            async () => {
              lifecycle!.assertOwned();
              const sha = commitChanges();
              await workStore!.setTaskReview(args.task, lifecycle!.owner, {
                branch: tree.branch,
                sha,
                base,
              });
              audit('developer_review_registered', {
                detail: JSON.stringify({ branch: tree.branch, sha, base }),
              });
              return sha;
            },
          )
        : commitChanges();
    } catch {
      throw new CliUsageError('Runtime Git commit failed; changes retained for review');
    }
    if (options.requirements) {
      const feature = {
        key: args.task,
        title: featureSpec!.title,
        doc_path: featureDoc!,
        git_sha: commit,
        status: 'in_review',
      };
      const revision = options.requirements.revision;
      if (revision) {
        const evidence = {
          version: featureSpec!.version,
          answersHash: createHash('sha256').update(revision.answers).digest('hex'),
        };
        const auditAnswers = (status: string) =>
          recordAudit(
            'answer_decision',
            'human_decision',
            revision.decisionId,
            {
              status,
              detail: JSON.stringify({
                ...evidence,
                gitSha: commit,
                decisionId: revision.decisionId,
              }),
            },
            {
              projectId: config.project.id,
              actorType: 'human',
              actorId: 'operator',
              taskKey: args.task,
              executionId,
              policyDecision: evaluatePolicy(
                'answer_decision',
                'human',
                config.operator.autonomyLevel,
              ),
            },
          );
        await workStore!.reviseFeature(
          feature,
          revision.gitSha,
          revision.decisionId,
          lifecycle!.owner,
          evidence,
          () => auditAnswers('featurespec_answers_registered'),
        );
        try {
          auditAnswers('featurespec_answers_incorporated');
        } catch (cause) {
          throw new Error(
            'Feature revision registered; audit confirmation pending. Inspect WorkStore before retrying.',
            { cause },
          );
        }
      } else workStore!.createFeature(feature);
    }
    if (options.architect) {
      const input = options.architect;
      const paths = architectPaths(config.project.brain.path, input.key);
      const revision = input.revision;
      const evidence = revision
        ? {
            decisionId: revision.decisionId,
            answersHash: createHash('sha256').update(revision.answers).digest('hex'),
            beforeCommit: () =>
              audit('design_answers_registered', {
                detail: JSON.stringify({
                  gitSha: commit,
                  answersHash: createHash('sha256').update(revision!.answers).digest('hex'),
                }),
              }),
          }
        : undefined;
      await workStore!.importTaskDag(designProposal!.dag, workStore!.getFeature(input.key)!, {
        design: {
          feature_key: input.key,
          doc_path: paths.doc,
          dag_path: paths.dag,
          git_sha: commit,
          feature_sha: input.gitSha,
        },
        owner: lifecycle!.owner,
        revision: evidence,
      });
      audit('design_registered', { detail: JSON.stringify({ gitSha: commit }) });
    }
    const stat = git(tree.path, ['diff', '--stat', base, commit]);
    audit('ready_for_review');
    telemetryStatus = 'ok';
    log(`rama lista para revisión\nRama: ${tree.branch}\nCommit: ${commit}\n${stat}`);
    return {
      branch: tree.branch,
      commit,
      stat,
      ...(featureSpec
        ? {
            requirementsQuestions: featureSpec.openQuestions,
            requirementsVersion: featureSpec.version,
          }
        : {}),
    };
  } catch (error) {
    if (error instanceof EvalCriterionTerminationError) {
      verifierClosed = false;
      if (workStore && lifecycle)
        await workStore.markVerifierInfrastructureFailure(args.task, lifecycle.owner);
    }
    telemetryStatus = 'error';
    const guard =
      error instanceof ChangeZonesExceededError ||
      error instanceof MissingTestError ||
      error instanceof DeveloperGuardError;
    const infrastructure =
      error instanceof VerifierInfrastructureError ||
      error instanceof EvalCriterionTerminationError;
    const reason = guard
      ? error.diagnostic()
      : error instanceof EvalCriterionTerminationError
        ? VERIFIER_INFRASTRUCTURE_PREFIX +
          'verifier termination unconfirmed; SA-026 recovery required'
        : error instanceof VerifierInfrastructureError || error instanceof WorkerExecutionError
          ? error.message
          : 'Worker failed (' +
            failureDiagnostic(error instanceof Error ? error.message : '', exitCode) +
            '): ' +
            verifierFailure('tests', [], [], 'fail', String(error), [
              common,
              process.env.HOME ?? '',
              process.env.USERPROFILE ?? '',
            ]).detail;
    audit(interrupted ? 'interrupted' : 'failed', {
      reason,
      detail: JSON.stringify({ exitCode: exitCode ?? null }),
    });
    await recordAttempt(
      error instanceof EvalCriterionTerminationError ? [error.result] : [],
      guard
        ? 'guard_rejected'
        : infrastructure
          ? 'infrastructure_error'
          : error instanceof EvalIntegrityError
            ? 'criteria_tampered'
            : exitCode === 0
              ? 'runtime_error'
              : 'executor_error',
      reason,
    );
    if (error instanceof Error) workerFailureReasons.set(error, reason);
    throw error;
  } finally {
    try {
      await telemetry?.finish(telemetryStatus);
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
