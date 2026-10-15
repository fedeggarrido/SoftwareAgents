import { CliUsageError } from './cliErrors.js';

/** Inherited by every managed executor and autopilot child, including its shell commands. */
export const MANAGED_EXECUTION_ENV = 'SA_MANAGED_EXECUTION';

export function assertEvalRunAllowed(env = process.env): void {
  if (env.CI !== undefined)
    throw new CliUsageError('eval run is forbidden when CI is defined (even CI=false)');
  if (
    [MANAGED_EXECUTION_ENV, 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'].some(
      (key) => env[key] !== undefined,
    )
  )
    throw new CliUsageError('eval run is operator-only; autopilot/worker execution is forbidden');
}
