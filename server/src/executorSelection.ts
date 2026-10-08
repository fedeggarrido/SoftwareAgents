import type { AgentSpec } from '../../core/src/agentSpec.js';
import type { CapacitySnapshot } from '../../core/src/capacity.js';
import type { ExecutorId } from './executors/executor.js';
import { type MachineQuotaPolicy, type QuotaDecision, quotaGate } from './quotaGate.js';

export interface ExecutorPreference {
  executor: ExecutorId;
  model?: string;
}
export type ModelPolicy = Record<string, ExecutorPreference[]>;
export interface SelectionSnapshot {
  allowedExecutors: readonly string[];
  machinePolicy: MachineQuotaPolicy | undefined;
  capacities: Partial<Record<ExecutorId, CapacitySnapshot>>;
  active: Partial<Record<ExecutorId, number>>;
  nowS: number;
  coverage?: {
    scope: 'runtime_slots';
    interactiveSessions: 'excluded_from_worker_limit';
    counts: Record<
      ExecutorId,
      {
        runtimeSlots: number;
        observedSessions: number;
        observedRuntimeSessions: number;
        blockedSlots: string[];
      }
    >;
    offices: { scope: 'office'; workspaces: string[]; source: 'office_store' }[];
    unobservedInteractiveSessions: 'not_counted';
  };
}

/** Order is a preference, never permission. Waiting does not trigger fallback (SA-038). */
export function selectExecutor(agent: AgentSpec, policy: ModelPolicy, snapshot: SelectionSnapshot) {
  const capability = agent.modelPolicy.capabilityClass;
  const alternatives = (Object.hasOwn(policy, capability) ? policy[capability] : []).filter((p) =>
    snapshot.allowedExecutors.includes(p.executor),
  );
  const choice = alternatives[0] ?? null;
  const gate: QuotaDecision = choice
    ? quotaGate(
        choice.executor,
        snapshot.machinePolicy,
        snapshot.capacities[choice.executor],
        snapshot.active[choice.executor] ?? NaN,
        snapshot.nowS,
      )
    : { status: 'wait', resetsAt: null, reason: `No allowed executor for ${capability}` };
  return {
    choice,
    alternatives: alternatives.slice(1),
    gate,
    reason: choice
      ? `${agent.identity.role} → ${capability} → first allowed preference ${choice.executor}; ${gate.reason}`
      : gate.reason,
  };
}
