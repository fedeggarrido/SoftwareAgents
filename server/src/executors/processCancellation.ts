import { type ChildProcess, execFileSync } from 'child_process';

import {
  EXECUTOR_TASKKILL_TIMEOUT_MS,
  EXECUTOR_TERMINATION_RETRY_MS,
  EXECUTOR_TERMINATION_TIMEOUT_MS,
} from '../constants.js';
import { withoutOperatorToken } from '../featureIngress.js';
import { cancelRegisteredProcess } from './registeredProcess.js';

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
    // Node releases the process handle at exit, before stdio drains and close fires.
    // Its PID may already belong to another process; never target it again.
    if (proc.exitCode !== null || proc.signalCode !== null) {
      failure = undefined;
      return;
    }
    if (process.platform === 'win32' && Date.now() + EXECUTOR_TASKKILL_TIMEOUT_MS > deadline)
      return;
    try {
      if (cancelRegisteredProcess(proc)) return;
      if (process.platform === 'win32')
        execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
          env: withoutOperatorToken(process.env),
          windowsHide: true,
          timeout: EXECUTOR_TASKKILL_TIMEOUT_MS,
        });
      else process.kill(-proc.pid, 'SIGKILL');
      failure = undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        failure = undefined;
        return;
      }
      failure = error instanceof Error ? error : new Error(String(error));
      const attemptBudget = process.platform === 'win32' ? EXECUTOR_TASKKILL_TIMEOUT_MS : 0;
      if (!retry && Date.now() + EXECUTOR_TERMINATION_RETRY_MS + attemptBudget <= deadline) {
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
      failure = undefined;
      if (retry) clearTimeout(retry);
      retry = undefined;
    },
  };
}
