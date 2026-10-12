import { createHash } from 'crypto';

import { EXECUTOR_CATALOG, type ExecutorId, isExecutorId } from '../../core/src/executorCatalog.js';
import type {
  ExecutorAvailability,
  ExecutorReasonCode,
  ExecutorState,
  ExecutorToggleResult,
  ModelTier,
  RequestExecutorState,
  SetExecutorEnabled,
} from '../../core/src/messages.js';
import type { ProjectOperatorConfig } from '../../core/src/project.js';
import { canonicalJson } from './configPersistence.js';
import type { ExecutorObservation } from './executorProbes.js';
import type { SelectionSnapshot } from './executorSelection.js';
import { MODEL_TIERS } from './modelTiers.js';
import { quotaGate } from './quotaGate.js';

const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ID = 64;
const MAX_TOKEN = 128;

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max;
}
function exactKeys(msg: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(msg);
  return present.length === keys.length && keys.every((k) => Object.hasOwn(msg, k));
}

export type ParsedSetExecutorEnabled =
  | { ok: true; msg: SetExecutorEnabled }
  /** `echo` is only what can be safely reflected in executorToggleResult. */
  | {
      ok: false;
      errorCode: 'invalid_request' | 'unknown_executor';
      echo?: { projectId: string; executorId: string; requestId: string };
    };

/** Runtime validation mirroring the AsyncAPI schema: TypeScript casts are not enough on the wire. */
export function parseSetExecutorEnabled(msg: Record<string, unknown>): ParsedSetExecutorEnabled {
  const keys = ['type', 'projectId', 'executorId', 'enabled', 'requestId', 'expectedRevision'];
  const echo =
    boundedString(msg.requestId, MAX_TOKEN) &&
    boundedString(msg.projectId, MAX_ID) &&
    boundedString(msg.executorId, MAX_ID)
      ? { projectId: msg.projectId, executorId: msg.executorId, requestId: msg.requestId }
      : undefined;
  if (
    msg.type !== 'setExecutorEnabled' ||
    !exactKeys(msg, keys) ||
    typeof msg.enabled !== 'boolean' ||
    !boundedString(msg.projectId, MAX_ID) ||
    !PROJECT_ID.test(msg.projectId) ||
    !boundedString(msg.requestId, MAX_TOKEN) ||
    !boundedString(msg.expectedRevision, MAX_TOKEN) ||
    typeof msg.executorId !== 'string'
  )
    return { ok: false, errorCode: 'invalid_request', ...(echo ? { echo } : {}) };
  if (!isExecutorId(msg.executorId))
    return { ok: false, errorCode: 'unknown_executor', ...(echo ? { echo } : {}) };
  return { ok: true, msg: msg as unknown as SetExecutorEnabled };
}

export function parseRequestExecutorState(
  msg: Record<string, unknown>,
): RequestExecutorState | undefined {
  return msg.type === 'requestExecutorState' &&
    exactKeys(msg, ['type', 'projectId']) &&
    boundedString(msg.projectId, MAX_ID) &&
    PROJECT_ID.test(msg.projectId)
    ? (msg as unknown as RequestExecutorState)
    : undefined;
}

/** Only well-formed client capability lists are honoured; anything else is a legacy client. */
export function clientWantsExecutorControls(msg: Record<string, unknown>): boolean {
  const caps = msg.capabilities;
  return Array.isArray(caps) && caps.length <= 8 && caps.includes('executorControls');
}

/**
 * Opaque, changes only when this Project's Operator policy changes. Canonical, so a
 * config rewrite that merely reorders keys is not a spurious SA-088 CAS conflict.
 */
export function operatorRevision(operator: ProjectOperatorConfig | undefined): string {
  return createHash('sha256')
    .update(canonicalJson(operator ?? null))
    .digest('hex')
    .slice(0, 16);
}

function levelsFor(executor: ExecutorId, operator: ProjectOperatorConfig): ModelTier[] {
  const catalog = operator.modelTiers;
  if (!catalog) return [];
  const cap = MODEL_TIERS.indexOf(catalog.maxTier);
  return MODEL_TIERS.filter(
    (tier, index) =>
      index <= cap && catalog.tiers[tier]?.candidates.some((c) => c.executor === executor),
  );
}

export interface ExecutorStateInput {
  projectId: string;
  /** Undefined = the Project's Operator policy was rejected or is unavailable. */
  operator: ProjectOperatorConfig | undefined;
  snapshot: SelectionSnapshot | undefined;
  sequence: number;
  canManage: boolean;
  nowS: number;
  /** An availability change has no verified result: launches are blocked (SA-088). */
  recoveryRequired?: boolean;
  /** Technical probes (SA-089); absent = not observed yet. */
  observations?: Partial<Record<ExecutorId, ExecutorObservation>>;
}

/** Probe facts as reason codes. Unknown never blocks; a proven problem does. */
function probeReasons(observation: ExecutorObservation | undefined, nowS: number) {
  const reasons: ExecutorReasonCode[] = [];
  if (!observation) return { reasons: ['probe_unknown' as const], blocked: false };
  if (observation.installation === 'missing') reasons.push('not_installed');
  else if (observation.installation === 'unsupported') reasons.push('unsupported_version');
  if (observation.authentication === 'required') reasons.push('auth_required');
  // Auth of a binary that is missing or unsupported is moot, not unknown.
  const installed = observation.installation === 'ready' || observation.installation === 'unknown';
  if (
    observation.installation === 'unknown' ||
    (installed && observation.authentication === 'unknown')
  )
    reasons.push('probe_unknown');
  if (nowS > observation.staleAfter) reasons.push('probe_stale');
  return {
    reasons,
    blocked:
      observation.installation === 'missing' ||
      observation.installation === 'unsupported' ||
      observation.authentication === 'required',
  };
}

/**
 * Read-only projection for the office: what the Operator enabled, what the SA-036
 * gate says now and what the SA-089 probes observed. Unobserved or unknown probe
 * facts are flagged with `probe_unknown` without blocking eligibility.
 */
export function buildExecutorState(input: ExecutorStateInput): ExecutorState {
  const { operator, snapshot } = input;
  const executors = EXECUTOR_CATALOG.map(({ id }): ExecutorAvailability => {
    const reasons: ExecutorReasonCode[] = [];
    const base: ExecutorAvailability = {
      executorId: id,
      enabled: false,
      eligible: false,
      reasonCodes: reasons,
      installation: 'unknown',
      version: null,
      authentication: 'unknown',
      levels: [],
      quotaGate: 'unknown',
      activeExecutions: null,
      concurrencyLimit: null,
      checkedAt: null,
      staleAfter: null,
    };
    if (!operator || !snapshot) {
      reasons.push('configuration_unavailable');
      return base;
    }
    const enabled = operator.allowedExecutors.includes(id);
    const levels = levelsFor(id, operator);
    const active = snapshot.active[id] ?? null;
    const limit = snapshot.machinePolicy?.maxConcurrent?.[id] ?? null;
    const gate = quotaGate(
      id,
      snapshot.machinePolicy,
      snapshot.capacities[id],
      active ?? NaN,
      snapshot.nowS,
      (snapshot.active.claude ?? 0) + (snapshot.active.codex ?? 0),
    );
    const quota: ExecutorAvailability['quotaGate'] =
      gate.status === 'go'
        ? 'allow'
        : gate.status === 'wait' && gate.cause === 'quota'
          ? 'block'
          : 'unknown';
    if (!enabled) reasons.push('operator_disabled');
    if (operator.modelTiers && !levels.length) reasons.push('no_allowed_level');
    if (quota === 'block') reasons.push('quota_blocked');
    else if (quota === 'unknown') reasons.push('quota_unknown');
    const full = gate.status === 'wait' && gate.cause === 'concurrency';
    if (full) reasons.push('concurrency_full');
    // Missing/invalid machine policy, or a change awaiting recovery: launches fail closed.
    if (
      (enabled && gate.status === 'wait' && gate.cause === 'configuration') ||
      input.recoveryRequired
    )
      reasons.push('configuration_unavailable');
    const observation = input.observations?.[id];
    const probe = probeReasons(observation, input.nowS);
    reasons.push(...probe.reasons);
    return {
      ...base,
      ...(observation
        ? {
            installation: observation.installation,
            version: observation.version,
            authentication: observation.authentication,
            checkedAt: observation.checkedAt,
            staleAfter: observation.staleAfter,
          }
        : {}),
      enabled,
      // Eligible only where the worker's own gate would admit (go) or probe.
      eligible:
        enabled &&
        !input.recoveryRequired &&
        !probe.blocked &&
        gate.status !== 'wait' &&
        !(operator.modelTiers && !levels.length),
      levels,
      quotaGate: quota,
      activeExecutions: active,
      concurrencyLimit: limit,
    };
  });
  return {
    type: 'executorState',
    projectId: input.projectId,
    revision: operatorRevision(operator),
    sequence: input.sequence,
    observedAt: input.nowS,
    canManage: input.canManage,
    configurationStatus: input.recoveryRequired
      ? 'recovery_required'
      : operator && snapshot
        ? 'ready'
        : 'invalid',
    executors,
  };
}

export function toggleResult(
  echo: { projectId: string; executorId: string; requestId: string },
  status: ExecutorToggleResult['status'],
  errorCode?: ExecutorToggleResult['errorCode'],
  revision?: string,
): ExecutorToggleResult {
  return {
    type: 'executorToggleResult',
    projectId: echo.projectId,
    executorId: echo.executorId,
    requestId: echo.requestId,
    status,
    ...(errorCode ? { errorCode } : {}),
    ...(revision ? { revision } : {}),
  };
}
