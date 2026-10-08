import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

import * as agentSchema from '../../core/schemas/agent-spec.schema.json';
import type { AgentSpec } from '../../core/src/agentSpec.js';
import { compileAgent, TOOL_POLICY_VERSION } from './agentCompiler.js';
import { AuditLog, recordAudit } from './auditLog.js';
import { ClaudeCliExecutor } from './executors/claudeCliExecutor.js';
import { CodexCliExecutor } from './executors/codexCliExecutor.js';
import { ExecutionRegistry } from './executors/executionRegistry.js';
import type { ExecutionHandle } from './executors/executor.js';
import { guardProtectedPaths } from './executors/protectedPaths.js';
import { WorktreeManager } from './executors/worktreeManager.js';
import { selectExecutor } from './executorSelection.js';
import {
  acquireExecutorSlot,
  executorSlotsDirectory,
  withExecutorAdmission,
} from './executorSlots.js';
import { HumanDecisions } from './humanDecisions.js';
import { loadModelPolicy, loadTierRule } from './modelPolicy.js';
import { admitModelTier } from './modelTierAdmission.js';
import type { TierSelection } from './modelTiers.js';
import { resolveInside } from './pathGuard.js';
import { evaluatePolicy } from './policy.js';
import { loadProjectConfig } from './projectConfig.js';
import { readSelectionSnapshot } from './quotaCommand.js';
import { type QuotaDecision, quotaGate } from './quotaGate.js';
import { compileSchema, validateSchema } from './schemaValidation.js';
import { taskModelInputs } from './taskModelInputs.js';
import type { WorkStore } from './workstore/WorkStore.js';

export interface WorkerArgs {
  task: string;
  brief: string;
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
    throw new Error('Usage: pixel-agents worker run --task SA-### --brief <file>');
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
    if (!['--task', '--brief'].includes(key) || !value || value.startsWith('--') || values[key])
      throw new Error('Expected unique --task and --brief values');
    values[key] = value;
  }
  if (!/^SA-\d{3,}$/.test(values['--task'] ?? '') || !values['--brief'])
    throw new Error('Expected --task SA-### and --brief <file>');
  return {
    task: values['--task'],
    brief: values['--brief'],
    ...(selection ? { selectExecutor: true } : {}),
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
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
}

export async function runWorker(args: WorkerArgs, options: WorkerOptions = {}) {
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? console.log;
  const config = loadProjectConfig(cwd);
  if (!config)
    throw new Error('worker run requires .softwareagents/project.yaml in the main checkout');
  const decision = evaluatePolicy('launch_execution', 'human', config.operator.autonomyLevel);
  const executionId = randomUUID();
  let tierSelection: TierSelection | undefined;
  const audit = (status: string) =>
    recordAudit(
      'launch_execution',
      'execution',
      executionId,
      {
        status,
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
  if (
    decision.outcome !== 'allow' ||
    (!config.operator.modelTiers &&
      !args.selectExecutor &&
      !config.operator.allowedExecutors.includes('claude'))
  ) {
    audit('denied');
    throw new Error('Operator config must allow the claude executor for this Project');
  }
  // Resolve/read before any launch; task data never selects executable or authority.
  const brief = fs.readFileSync(path.resolve(cwd, args.brief), 'utf8');
  const template = path.join(__dirname, 'agents/templates/developer.yaml');
  const sourceTemplate = path.resolve(__dirname, '../../agents/templates/developer.yaml');
  const spec = validateSchema(
    compileSchema<AgentSpec>(agentSchema),
    parse(fs.readFileSync(fs.existsSync(template) ? template : sourceTemplate, 'utf8')),
  );
  const taskData = {
    task: { key: args.task, brief },
    repository: { projectId: config.project.id },
  };
  const compiled = compileAgent(spec, 'developer', taskData);
  const tierPolicy = config.operator.modelTiers;
  const tierRule = tierPolicy ? (tierPolicy.rule ?? loadTierRule(cwd)) : undefined;
  const modelPolicy = !tierPolicy && args.selectExecutor ? loadModelPolicy(cwd) : undefined;
  let selection = modelPolicy
    ? selectExecutor(spec, modelPolicy, readSelectionSnapshot(config.operator))
    : undefined;
  if (selection && !selection.choice) {
    log(selection.reason);
    audit('quota_wait');
    process.exitCode = 3;
    return { branch: '', commit: null, stat: '', quotaDecision: selection.gate };
  }
  const common = path.resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']));
  const release = acquireTaskLock(common, args.task);
  let handle: ExecutionHandle | undefined;
  let interrupted = false;
  let executionFinished = false;
  let eventsStarted = false;
  let slotFailure: unknown;
  let slot: ReturnType<typeof acquireExecutorSlot>;
  let workStore: WorkStore | undefined;
  const cancel = () => {
    interrupted = true;
    try {
      handle?.cancel();
    } catch {
      log('Executor cancellation failed; verify processes before recovering the task lock.');
    }
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    let selectedExecutor = selection?.choice?.executor ?? 'claude';
    // Both locks are held during the fresh gate decision and exclusive slot creation.
    // The admission lock spans projects/tasks; the slot spans the entire Execution.
    const tierAdmission =
      tierPolicy && tierRule
        ? await (async () => {
            const { openWorkStore } = await import('./workstore/SqliteWorkStore.js');
            workStore = await openWorkStore({ repositoryPath: cwd, projectId: config.project.id });
            return admitModelTier(
              spec,
              tierRule,
              tierPolicy,
              taskModelInputs(config, workStore.getTask(args.task), args.task),
              config.operator,
              executionId,
            );
          })()
        : undefined;
    if (tierAdmission) {
      tierSelection = tierAdmission.selection;
      selectedExecutor = tierSelection.choice?.executor ?? 'claude';
      log(
        JSON.stringify({
          ...tierSelection,
          coverage: tierAdmission.snapshot.coverage,
          active: tierAdmission.snapshot.active,
        }),
      );
    }
    const admission = tierPolicy
      ? tierAdmission
        ? { gate: tierAdmission.selection.gate, slot: tierAdmission.slot }
        : undefined
      : withExecutorAdmission(selectedExecutor, executionId, (owner) => {
          const snapshot = readSelectionSnapshot(config.operator);
          if (modelPolicy) selection = selectExecutor(spec, modelPolicy, snapshot);
          // Legacy manual runs retain conservative defaults for pre-quota configs.
          if (!modelPolicy) {
            snapshot.machinePolicy ??= { quotaThresholds: {}, maxConcurrent: {} };
            snapshot.machinePolicy.quotaThresholds[selectedExecutor] ??= 0;
            snapshot.machinePolicy.maxConcurrent[selectedExecutor] ??= 1;
          }
          log(
            JSON.stringify({
              executor: selectedExecutor,
              active: snapshot.active[selectedExecutor],
              coverage: snapshot.coverage,
            }),
          );
          const gate =
            selection?.gate ??
            quotaGate(
              selectedExecutor,
              snapshot.machinePolicy,
              snapshot.capacities[selectedExecutor],
              snapshot.active[selectedExecutor] ?? NaN,
              snapshot.nowS,
            );
          if (gate.status === 'wait') return { gate, slot: undefined };
          const reserved = acquireExecutorSlot(selectedExecutor, gate.concurrencyLimit, owner);
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
    if (admissionGate.status === 'wait' || !slot) {
      log(admissionGate.reason);
      audit('quota_wait');
      process.exitCode = 3;
      return { branch: '', commit: null, stat: '', quotaDecision: admissionGate };
    }
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
    const tree = await new WorktreeManager({
      repositoryPath: cwd,
      defaultBranch: config.project.repo.defaultBranch,
      manualPreparation: true,
    }).create(args.task, 'worker');
    if (git(tree.path, ['status', '--porcelain', '--untracked-files=all']))
      throw new Error('Existing task worktree is dirty; review it before retrying');
    const base = git(tree.path, ['rev-parse', 'HEAD']);
    if (interrupted) throw new Error('Worker interrupted');
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
    );
    slot.markLaunching('registered_wrapper');
    handle = executor.start({
      executionId,
      projectId: config.project.id,
      taskKey: args.task,
      role: 'developer',
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
      timeoutMin: 30,
      registerProcess: (pid) => slot!.setExecutionProcess(pid),
    });
    if (workStore && tierSelection?.choice) {
      if (!workStore.getTask(args.task))
        workStore.createTask({ key: args.task, type: 'unknown', status: 'DRAFT' });
      await workStore.createExecution({
        key: executionId,
        task_key: args.task,
        agent_template_version: spec.metadata.version,
        executor: selectedExecutor,
        model_id: tierSelection.choice.model,
        model_tier: tierSelection.tier,
        model_effort: tierSelection.choice.effort ?? null,
        selection_reason: tierSelection.reason,
        session_id: handle.sessionId ?? null,
        // The manual worker owns a task lock, not a WorkStore lease. Its real
        // supervisor PID remains in the existing registry/slot, never in recovery.
        pid: null,
        started_at: new Date().toISOString(),
        system_prompt_hash: createHash('sha256').update(compiled.context).digest('hex'),
        project_brain_sha: base,
        task_version: workStore.getTask(args.task)!.version,
        tool_policy_version: TOOL_POLICY_VERSION,
      });
    }
    if (handle.sessionId) slot.setSession(handle.sessionId);
    let exitCode: number | undefined;
    eventsStarted = true;
    for await (const event of handle.events) {
      if (event.type === 'started') {
        try {
          slot.setSession(event.sessionId);
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
        executionFinished = true;
      }
    }
    if (slotFailure) throw slotFailure;
    if (interrupted || exitCode !== 0)
      throw new Error('Execution failed or was interrupted; changes retained for review');
    if (
      git(tree.path, ['symbolic-ref', '--short', 'HEAD']) !== tree.branch ||
      git(tree.path, ['rev-parse', 'HEAD']) !== base
    )
      throw new Error('Execution changed Git HEAD; refusing runtime commit');
    if (!git(tree.path, ['status', '--porcelain', '--untracked-files=all'])) {
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
    if (gate.decision.outcome !== 'allow') {
      if (gate.decision.outcome === 'require_human') {
        const { openWorkStore } = await import('./workstore/SqliteWorkStore.js');
        const store = await openWorkStore({ repositoryPath: cwd, projectId: config.project.id });
        try {
          if (!store.getTask(args.task))
            store.createTask({
              key: args.task,
              type: 'implementation',
              // This legacy worker has finished its CLI and has no WorkStore lease.
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
    git(tree.path, [
      '-c',
      'core.hooksPath=',
      'commit',
      '-m',
      `${workerCommitSubject(args.task, brief)}\n\nSoftwareAgents-Execution: ${executionId}`,
    ]);
    const commit = git(tree.path, ['rev-parse', 'HEAD']);
    const stat = git(tree.path, ['diff', '--stat', base, commit]);
    audit('ready_for_review');
    log(`rama lista para revisión\nRama: ${tree.branch}\nCommit: ${commit}\n${stat}`);
    return { branch: tree.branch, commit, stat };
  } catch (error) {
    audit(interrupted ? 'interrupted' : 'failed');
    throw error;
  } finally {
    workStore?.close();
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    if (!handle || !eventsStarted || executionFinished) {
      try {
        slot?.release();
      } finally {
        release();
      }
    } else log('Task lock and executor slot retained: executor termination was not confirmed.');
  }
}
