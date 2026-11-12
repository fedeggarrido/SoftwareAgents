import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

import * as agentSchema from '../../core/schemas/agent-spec.schema.json';
import type { AgentSpec } from '../../core/src/agentSpec.js';
import { ROLE_PROFILES } from './agentCompiler.js';
import { CliUsageError } from './cliErrors.js';
import { CLAUDE_OAUTH_REFRESH_CONTENTION } from './constants.js';
import type { SelectionSnapshot } from './executorSelection.js';
import { resolveInside } from './pathGuard.js';
import type { MachineQuotaPolicy } from './quotaGate.js';
import { compileSchema, validateSchema } from './schemaValidation.js';
import type { WorkerArgs } from './worker.js';

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
    // SAFETY: validation above accepts only these two executor identifiers.
    ...(values['--executor'] ? { executor: values['--executor'] as 'claude' | 'codex' } : {}),
    ...(selection ? { selectExecutor: true } : {}),
  };
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
    // SAFETY: fs.openSync errors expose Node's errno code.
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

export function loadWorkerAgentSpec(file?: string, role = 'developer'): AgentSpec {
  if (!Object.hasOwn(ROLE_PROFILES, role)) throw new CliUsageError('Unsupported task role');
  const template = path.join(__dirname, `agents/templates/${role}.yaml`);
  const source = path.resolve(__dirname, `../../agents/templates/${role}.yaml`);
  return validateSchema(
    compileSchema<AgentSpec>(agentSchema),
    parse(fs.readFileSync(file ?? (fs.existsSync(template) ? template : source), 'utf8')),
  );
}
/** Manual runs without a quota policy keep conservative defaults (SA-036). */
export function legacyMachinePolicy(snapshot: SelectionSnapshot, executor: 'claude' | 'codex') {
  snapshot.machinePolicy ??= { quotaThresholds: {}, maxConcurrent: {} };
  snapshot.machinePolicy.quotaThresholds[executor] ??= 0;
  snapshot.machinePolicy.maxConcurrent[executor] ??= 1;
  // SAFETY: conservative defaults above fill both executors as they are admitted.
  return snapshot.machinePolicy as MachineQuotaPolicy;
}

/** Only fixed categories and a numeric exit code cross into Task/audit storage. */
export function failureDiagnostic(detail: string, exitCode?: number): string {
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
