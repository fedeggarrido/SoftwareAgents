import type { CapacitySnapshot } from '../../core/src/capacity.js';
import type { ExecutorId } from './executors/executor.js';

export const MAX_QUOTA_OBSERVATION_AGE_S = 60;

/** Trusted machine policy: thresholds are minimum remaining percentages. */
export interface MachineQuotaPolicy {
  quotaThresholds: Partial<Record<ExecutorId, number>>;
  maxConcurrent: Partial<Record<ExecutorId, number>>;
}
export type QuotaDecision =
  | { status: 'go' | 'probe'; concurrencyLimit: number; reason: string }
  | { status: 'wait'; resetsAt: number | null; reason: string };

/** Pure admission decision; active = runtime slots + observed non-runtime sessions. */
export function quotaGate(
  executor: ExecutorId,
  policy: MachineQuotaPolicy | undefined,
  snapshot: CapacitySnapshot | undefined,
  active: number,
  nowS: number,
): QuotaDecision {
  const limit = policy?.maxConcurrent[executor];
  const threshold = policy?.quotaThresholds[executor];
  const wait = (reason: string, resetsAt: number | null = null): QuotaDecision => ({
    status: 'wait',
    resetsAt,
    reason,
  });
  if (
    limit === undefined ||
    threshold === undefined ||
    !Number.isInteger(limit) ||
    limit < 0 ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 100 ||
    !Number.isInteger(active) ||
    active < 0
  )
    return wait(`Missing or invalid machine quota policy/count for ${executor}`);
  if (active >= limit) return wait(`${executor}: machine concurrency limit ${limit} reached`);
  if (snapshot && snapshot.provider !== executor) return wait('Capacity provider mismatch');
  if (
    !Number.isFinite(nowS) ||
    (snapshot?.observedAt !== undefined &&
      snapshot.observedAt !== null &&
      !Number.isFinite(snapshot.observedAt)) ||
    snapshot?.windows.some(
      (w) =>
        (w.usedRatio !== null &&
          (!Number.isFinite(w.usedRatio) || w.usedRatio < 0 || w.usedRatio > 1)) ||
        (w.resetsAt !== null && !Number.isFinite(w.resetsAt)),
    )
  )
    return wait('Invalid capacity observation');
  const windows = snapshot?.windows.filter((w) => w.resetsAt === null || w.resetsAt > nowS) ?? [];
  const blocked = windows.filter((w) => w.usedRatio !== null && w.usedRatio > 1 - threshold / 100);
  if (blocked.length)
    return wait(
      `${executor}: remaining quota below ${threshold}%`,
      blocked.some((w) => w.resetsAt === null)
        ? null
        : Math.max(...blocked.map((w) => w.resetsAt!)),
    );
  const rejectedWindows =
    snapshot?.status === 'rejected'
      ? windows.filter((w) => w.usedRatio === null || w.usedRatio >= 1)
      : [];
  const unlocatedRejection =
    snapshot?.status === 'rejected' &&
    !snapshot.windows.some((w) => w.usedRatio === null || (w.usedRatio ?? 0) >= 1);
  if (
    snapshot?.status === 'rejected' &&
    (!snapshot.windows.length || rejectedWindows.length || (unlocatedRejection && windows.length))
  )
    return wait(
      `${executor}: capacity rejected`,
      !windows.length ||
        (rejectedWindows.length ? rejectedWindows : windows).some((w) => w.resetsAt === null)
        ? null
        : Math.max(...(rejectedWindows.length ? rejectedWindows : windows).map((w) => w.resetsAt!)),
    );
  const unknown =
    !snapshot ||
    snapshot.status === 'unknown' ||
    snapshot.status === 'reset' ||
    snapshot.confidence === 'low' ||
    snapshot.confidence === 'unknown' ||
    snapshot.observedAt === null ||
    snapshot.observedAt > nowS ||
    nowS - snapshot.observedAt > MAX_QUOTA_OBSERVATION_AGE_S ||
    windows.length !== snapshot.windows.length ||
    !windows.length ||
    windows.some((w) => w.usedRatio === null);
  if (unknown)
    return active >= 1
      ? wait(`${executor}: probe already active (machine limit 1)`)
      : {
          status: 'probe',
          concurrencyLimit: 1,
          reason: `${executor}: unknown capacity; one runtime probe (unobserved interactive sessions excluded)`,
        };
  return {
    status: 'go',
    concurrencyLimit: limit,
    reason: `${executor}: quota and runtime concurrency allow execution (unobserved interactive sessions excluded)`,
  };
}
