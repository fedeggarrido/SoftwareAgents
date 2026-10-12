import type { AgentSpec } from '../../core/src/agentSpec.js';
import type { CapacitySnapshot } from '../../core/src/capacity.js';
import type { ModelTier } from '../../core/src/modelTier.js';
import type { ExecutorObservation } from './executorProbes.js';
import type { ExecutorId } from './executors/executor.js';
import { type MachineQuotaPolicy, type QuotaDecision, quotaGate } from './quotaGate.js';

export type LaunchBlockCode =
  'not_installed' | 'unsupported_version' | 'auth_required' | 'probe_unknown' | 'probe_stale';

/**
 * SA-090: what an observation means for launching. Proven problems need the
 * Operator (install, upgrade, log in); an installation that could not be proven
 * is retried. Unknown authentication on a verified binary does not block: not
 * every supported CLI offers a verified status command, and a logged-out CLI
 * refuses to run by itself. `nowS` adds freshness; the office snapshot omits it,
 * since the worker always probes again before launching.
 */
export function launchBlock(
  observation: ExecutorObservation | undefined,
  nowS?: number,
): { code: LaunchBlockCode; needsOperator: boolean } | undefined {
  if (!observation) return { code: 'probe_unknown', needsOperator: false };
  if (observation.installation === 'missing') return { code: 'not_installed', needsOperator: true };
  if (observation.installation === 'unsupported')
    return { code: 'unsupported_version', needsOperator: true };
  if (observation.authentication === 'required')
    return { code: 'auth_required', needsOperator: true };
  if (observation.installation !== 'ready') return { code: 'probe_unknown', needsOperator: false };
  if (nowS !== undefined && !(nowS <= observation.staleAfter))
    return { code: 'probe_stale', needsOperator: false };
  return undefined;
}

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
  /**
   * SA-090: technical facts the caller probed itself. Absent = not observed by
   * this caller (quota check, office snapshot): selection does not filter on it.
   * Present = an Executor missing from it is unproven and never launched.
   */
  availability?: Partial<Record<ExecutorId, ExecutorObservation>>;
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

/** A candidate the selector skipped; only the Operator can change these. */
export interface CandidateExclusion {
  executor: ExecutorId;
  tier?: ModelTier;
  code:
    | 'operator_disabled'
    | Extract<LaunchBlockCode, 'not_installed' | 'unsupported_version' | 'auth_required'>;
}

/**
 * SA-090: no candidate can run and waiting will not change that. Quota,
 * concurrency and unproven probes are never a block: they wait and re-evaluate.
 */
export interface SelectionBlock {
  code:
    | 'no_enabled_executor'
    | 'no_allowed_level'
    | 'not_installed'
    | 'unsupported_version'
    | 'auth_required';
  exclusions: CandidateExclusion[];
}

/** Technical verdict for one candidate, only where the caller observed availability. */
export function availabilityVerdict(executor: ExecutorId, snapshot: SelectionSnapshot) {
  return snapshot.availability
    ? launchBlock(snapshot.availability[executor], snapshot.nowS)
    : undefined;
}

/** Operator-only exclusions; `undefined` = the candidate may be gated. */
export function excludeCandidate(
  executor: ExecutorId,
  snapshot: SelectionSnapshot,
): CandidateExclusion['code'] | undefined {
  if (!snapshot.allowedExecutors.includes(executor)) return 'operator_disabled';
  const verdict = availabilityVerdict(executor, snapshot);
  return verdict?.needsOperator ? (verdict.code as CandidateExclusion['code']) : undefined;
}

/** The candidate is allowed and installed but not proven right now: wait, no fallback. */
export function unprovenWait(
  executor: ExecutorId,
  snapshot: SelectionSnapshot,
): QuotaDecision | undefined {
  const verdict = availabilityVerdict(executor, snapshot);
  return verdict && !verdict.needsOperator
    ? {
        status: 'wait',
        resetsAt: null,
        reason: `${executor}: ${verdict.code}; availability is re-probed on the next run`,
        cause: 'availability',
      }
    : undefined;
}

/**
 * Deterministic: with no candidate at all the policy offers no level; when every
 * candidate was excluded, the first technical cause in preference order wins over
 * a plain Operator disable (enabling another Executor would not fix it).
 */
export function selectionBlock(
  candidates: number,
  waited: boolean,
  exclusions: CandidateExclusion[],
): SelectionBlock | undefined {
  if (waited) return undefined;
  if (!candidates) return { code: 'no_allowed_level', exclusions };
  for (const { code } of exclusions) if (code !== 'operator_disabled') return { code, exclusions };
  return { code: 'no_enabled_executor', exclusions };
}

/** Order is a preference, never permission. Waiting does not trigger fallback (SA-038). */
export function selectExecutor(agent: AgentSpec, policy: ModelPolicy, snapshot: SelectionSnapshot) {
  const capability = agent.modelPolicy.capabilityClass;
  const preferences = Object.hasOwn(policy, capability) ? policy[capability] : [];
  const exclusions: CandidateExclusion[] = [];
  const alternatives = preferences.filter((p) => {
    const code = excludeCandidate(p.executor, snapshot);
    if (code) exclusions.push({ executor: p.executor, code });
    return !code;
  });
  const choice = alternatives[0] ?? null;
  const block = choice ? undefined : selectionBlock(preferences.length, false, exclusions);
  const gate: QuotaDecision = choice
    ? (unprovenWait(choice.executor, snapshot) ??
      quotaGate(
        choice.executor,
        snapshot.machinePolicy,
        snapshot.capacities[choice.executor],
        snapshot.active[choice.executor] ?? NaN,
        snapshot.nowS,
        (snapshot.active.claude ?? 0) + (snapshot.active.codex ?? 0),
      ))
    : {
        status: 'wait',
        resetsAt: null,
        reason: `No allowed executor for ${capability}${block ? ` (${block.code})` : ''}`,
        cause: 'disabled',
      };
  const excluded = exclusions.map((e) => `${e.executor}: ${e.code}`).join('; ');
  return {
    choice,
    alternatives: alternatives.slice(1),
    exclusions,
    block,
    gate,
    reason: choice
      ? `${agent.identity.role} → ${capability} → first allowed preference ${choice.executor}; ${gate.reason}${excluded ? `; excluded ${excluded}` : ''}`
      : `${gate.reason}${excluded ? `; excluded ${excluded}` : ''}`,
  };
}
