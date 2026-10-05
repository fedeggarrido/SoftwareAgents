import { type ChildProcess, execFileSync } from 'child_process';

import { EXECUTOR_TERMINATION_RETRY_MS, EXECUTOR_TERMINATION_TIMEOUT_MS } from '../constants.js';

/** Request cancellation independently of process-close confirmation. Failed kills retry within
 * a bounded window; later cancel/timeout requests start another window. Only close finishes a run. */
export function processCancellation(child: () => ChildProcess | undefined) {
  let requested = false;
  let confirmed = false;
  let failure: Error | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let deadline = 0;
  const attempt = () => {
    const proc = child();
    if (confirmed || !proc?.pid) return;
    try {
      if (process.platform === 'win32')
        execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
          windowsHide: true,
          timeout: Math.max(1, deadline - Date.now()),
        });
      else process.kill(-proc.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      failure = error instanceof Error ? error : new Error(String(error));
      if (!retry && Date.now() + EXECUTOR_TERMINATION_RETRY_MS <= deadline) {
        retry = setTimeout(() => {
          retry = undefined;
          try {
            attempt();
          } catch {
            /* retained for the final summary */
          }
        }, EXECUTOR_TERMINATION_RETRY_MS);
      }
      throw failure;
    }
  };
  return {
    get requested() {
      return requested;
    },
    get failure() {
      return failure;
    },
    cancel() {
      if (confirmed) return;
      requested = true;
      deadline = Date.now() + EXECUTOR_TERMINATION_TIMEOUT_MS;
      attempt();
    },
    confirmClose() {
      confirmed = true;
      if (retry) clearTimeout(retry);
      retry = undefined;
    },
  };
}
