import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { WORKSTORE_PROCESS_TIMEOUT_MS } from '../constants.js';
import { windowsTerminationScript } from './windowsProcessRecovery.js';

const execute = promisify(execFile);

async function powershell(script: string): Promise<string> {
  try {
    const { stdout } = await execute(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: WORKSTORE_PROCESS_TIMEOUT_MS },
    );
    return stdout.trim();
  } catch (error) {
    const failure = error as { stderr?: string; code?: string | number; killed?: boolean };
    // Keep the diagnostic, not execFile's enormous embedded command/source code.
    throw new Error(
      `Windows process helper failed: ${failure.stderr?.trim() || (failure.killed ? 'timeout' : failure.code) || (error as Error).message}`,
    );
  }
}

function validatePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid)
    throw new Error('Invalid executor PID');
}

/** Exact OS creation timestamp. Only query the registered executor, never scan the host. */
export async function processStartIdentity(pid: number): Promise<string | null> {
  // Identity queries also serve the orchestrator's own lock. Termination still
  // rejects process.pid through validatePid.
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process PID');
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null;
    throw error;
  }
  if (process.platform !== 'win32')
    throw new Error('Executor process recovery currently requires Windows');
  const output = await powershell(
    `$ErrorActionPreference='Stop'; try { $p=Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks.ToString() } catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw } }`,
  );
  if (!output) return null;
  if (!/^\d+$/.test(output)) throw new Error('Cannot verify executor process identity');
  return output;
}

/** Fail closed on unverifiable identities or failed termination; never reuse their worktree. */
export async function terminateExecutionTree(
  pid: number,
  identity: string | null | undefined,
): Promise<void> {
  validatePid(pid);
  if (!identity || !/^\d+$/.test(identity))
    throw new Error('Executor lacks a recorded process creation identity; tree closure unproven');
  if (process.platform !== 'win32')
    throw new Error('Executor process recovery currently requires Windows');
  // Missing/reused root fails closed in the helper; it cannot prove descendants exited.
  const result = await powershell(windowsTerminationScript(pid, identity));
  if (result !== 'TREE_CLOSED') throw new Error('Executor tree closure unproven');
}
