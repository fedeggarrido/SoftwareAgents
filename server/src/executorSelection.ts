import type { AgentSpec } from '../../core/src/agentSpec.js';
import type { CapacitySnapshot } from '../../core/src/capacity.js';
import type { ModelTier } from '../../core/src/modelTier.js';
import { executorSupportsRole } from './agentCompiler.js';
import type { ExecutorObservation } from './executorProbes.js';
import type { ExecutorId } from './executors/executor.js';
import {
  type MachineQuotaPolicy,
  type QuotaCause,
  type QuotaDecision,
  quotaGate,
} from './quotaGate.js';

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
  /** SA-092: Operator narrowing of the tiers each Executor may run (absent = all). */
  executorLevels?: Partial<Record<ExecutorId, readonly ModelTier[]>>;
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
    | 'code_execution_not_mediated'
    | 'operator_disabled'
    /** SA-092: the Operator does not allow this Executor at this tier. */
    | 'level_disabled'
    | Extract<LaunchBlockCode, 'not_installed' | 'unsupported_version' | 'auth_required'>;
}

/**
 * SA-090: no candidate can run and waiting will not change that. Quota,
 * concurrency and unproven probes are never a block: they wait and re-evaluate.
 */
export interface SelectionBlock {
  code:
    | 'code_execution_not_mediated'
    | 'no_enabled_executor'
    | 'no_allowed_level'
    | 'not_installed'
    | 'unsupported_version'
    | 'auth_required';
  exclusions: CandidateExclusion[];
}

/** Content-free explanation of a worker admission refusal, also retained by evals. */
export interface ExecutionBlock {
  code: SelectionBlock['code'] | QuotaCause | 'admission_busy';
  tier: ModelTier | null;
  executor: ExecutorId | null;
  reason: string;
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
  tier?: ModelTier,
  role?: string,
): CandidateExclusion['code'] | undefined {
  if (role && !executorSupportsRole(executor, role)) return 'code_execution_not_mediated';
  if (!snapshot.allowedExecutors.includes(executor)) return 'operator_disabled';
  const levels = snapshot.executorLevels?.[executor];
  if (tier && levels && !levels.includes(tier)) return 'level_disabled';
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
 * an Operator choice (enabling another Executor would not fix it), and a level the
 * Operator disallowed (SA-092) is reported as no allowed level before a plain disable.
 */
export function selectionBlock(
  candidates: number,
  waited: boolean,
  exclusions: CandidateExclusion[],
): SelectionBlock | undefined {
  if (waited) return undefined;
  if (!candidates) return { code: 'no_allowed_level', exclusions };
  for (const { code } of exclusions)
    if (code !== 'operator_disabled' && code !== 'level_disabled') return { code, exclusions };
  if (exclusions.some((e) => e.code === 'level_disabled'))
    return { code: 'no_allowed_level', exclusions };
  return { code: 'no_enabled_executor', exclusions };
}

/** Order is a preference, never permission. Only quota waits permit policy-controlled fallback. */
export function selectExecutor(agent: AgentSpec, policy: ModelPolicy, snapshot: SelectionSnapshot) {
  const capability = agent.modelPolicy.capabilityClass;
  const preferences = Object.hasOwn(policy, capability) ? policy[capability] : [];
  const exclusions: CandidateExclusion[] = [];
  const alternatives = preferences.filter((p) => {
    const code = excludeCandidate(p.executor, snapshot, undefined, agent.identity.role);
    if (code) exclusions.push({ executor: p.executor, code });
    return !code;
  });
  let choice = alternatives[0] ?? null;
  const block = choice ? undefined : selectionBlock(preferences.length, false, exclusions);
  let gate: QuotaDecision = choice
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
  if (gate.status === 'wait' && gate.cause === 'quota' && agent.modelPolicy.fallbackAllowed) {
    for (const candidate of alternatives.slice(1)) {
      const candidateGate =
        unprovenWait(candidate.executor, snapshot) ??
        quotaGate(
          candidate.executor,
          snapshot.machinePolicy,
          snapshot.capacities[candidate.executor],
          snapshot.active[candidate.executor] ?? NaN,
          snapshot.nowS,
          (snapshot.active.claude ?? 0) + (snapshot.active.codex ?? 0),
        );
      if (candidateGate.status !== 'wait') {
        choice = candidate;
        gate = {
          ...candidateGate,
          reason: `quota fallback to ${candidate.executor}; ${candidateGate.reason}`,
        };
        break;
      }
    }
  }
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
