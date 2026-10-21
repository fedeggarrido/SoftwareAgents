import type { PolicyActor } from './policy.js';

export function featureIngressActor(actor: PolicyActor = 'human'): PolicyActor {
  return ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'].some(
    (key) => process.env[key] !== undefined,
  )
    ? 'agent'
    : actor;
}
