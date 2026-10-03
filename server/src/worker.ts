import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

import * as agentSchema from '../../core/schemas/agent-spec.schema.json';
import type { AgentSpec } from '../../core/src/agentSpec.js';
import { compileAgent } from './agentCompiler.js';
import { recordAudit } from './auditLog.js';
import { ClaudeCliExecutor } from './executors/claudeCliExecutor.js';
import { CodexCliExecutor } from './executors/codexCliExecutor.js';
import { ExecutionRegistry } from './executors/executionRegistry.js';
import type { ExecutionHandle } from './executors/executor.js';
import { guardProtectedPaths } from './executors/protectedPaths.js';
import { WorktreeManager } from './executors/worktreeManager.js';
import { selectExecutor } from './executorSelection.js';
import { HumanDecisions } from './humanDecisions.js';
import { loadModelPolicy } from './modelPolicy.js';
import { resolveInside } from './pathGuard.js';
import { evaluatePolicy } from './policy.js';
import { loadProjectConfig } from './projectConfig.js';
import { readSelectionSnapshot } from './quotaCommand.js';
import { compileSchema, validateSchema } from './schemaValidation.js';

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
  const audit = (status: string) =>
    recordAudit(
      'launch_execution',
      'execution',
      executionId,
      { status },
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
    (!args.selectExecutor && !config.operator.allowedExecutors.includes('claude'))
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
  const selection = args.selectExecutor
    ? selectExecutor(spec, loadModelPolicy(cwd), readSelectionSnapshot(config.operator))
    : undefined;
  if (selection) {
    log(selection.reason);
    if (!selection.choice || selection.gate.status === 'wait') {
      audit('quota_wait');
      process.exitCode = 3;
      return { branch: '', commit: null, stat: '', quotaDecision: selection.gate };
    }
  }
  const common = path.resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']));
  const release = acquireTaskLock(common, args.task);
  let handle: ExecutionHandle | undefined;
  let interrupted = false;
  let executionFinished = false;
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
      selection?.choice?.executor === 'codex'
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
      worktreePath: tree.path,
      timeoutMin: 30,
    });
    let exitCode: number | undefined;
    for await (const event of handle.events) {
      if (event.type === 'finished') {
        exitCode = event.exitCode;
        executionFinished = true;
      }
    }
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
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    if (!handle || executionFinished) release();
    else log('Task lock retained: executor termination was not confirmed.');
  }
}
