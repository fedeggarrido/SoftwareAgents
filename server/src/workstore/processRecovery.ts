import { execFileSync } from 'node:child_process';

function validatePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid)
    throw new Error('Invalid executor PID');
}

/** Exact OS creation timestamp. Only query the registered executor, never scan the host. */
export function processStartIdentity(pid: number): string | null {
  validatePid(pid);
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null;
    throw error;
  }
  if (process.platform !== 'win32')
    throw new Error('Executor process recovery currently requires Windows');
  const output = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='Stop'; try { $p=Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks.ToString() } catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw } }`,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
  ).trim();
  if (!output) return null;
  if (!/^\d+$/.test(output)) throw new Error('Cannot verify executor process identity');
  return output;
}

/** Fail closed on unverifiable identities or failed termination; never reuse their worktree. */
export function terminateExecutionTree(pid: number, identity: string | null | undefined): void {
  const current = processStartIdentity(pid);
  if (current === null) return;
  if (!identity) throw new Error('Live executor lacks a recorded process creation identity');
  if (current !== identity) return; // Registered process died; PID now belongs to someone else.
  execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'pipe',
    timeout: 10_000,
  });
  if (processStartIdentity(pid) === current) throw new Error('Executor tree is still alive');
}
