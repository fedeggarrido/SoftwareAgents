import type { CapacitySnapshot } from '../../core/src/capacity.js';

/** Compact evidence by window, preserving its own event time. A later reliable
 * observation supersedes that window; low confidence can only add restrictions.
 */
export function retainQuotaEvidence(
  snapshots: CapacitySnapshot[],
  nowS: number,
): CapacitySnapshot[] {
  const parts = snapshots
    .filter((s) => s.observedAt === null || s.observedAt <= nowS)
    .flatMap((s) => {
      if (!s.windows.length) return [s];
      const located = s.windows.some((w) => w.usedRatio === null || (w.usedRatio ?? 0) >= 1);
      return s.windows.map((w) => {
        const rejected =
          s.status === 'rejected' && (!located || w.usedRatio === null || (w.usedRatio ?? 0) >= 1);
        return {
          ...s,
          status: s.status === 'rejected' && !rejected ? ('allowed' as const) : s.status,
          windows: [{ ...w, usedRatio: rejected ? 1 : w.usedRatio }],
        };
      });
    });
  const unique = [...new Map(parts.map((s) => [JSON.stringify(s), s])).values()];
  return unique.filter(
    (s) =>
      !unique.some(
        (later) =>
          later.provider === s.provider &&
          ['high', 'exact'].includes(later.confidence) &&
          later.status !== 'unknown' &&
          later.observedAt !== null &&
          later.observedAt > (s.observedAt ?? -Infinity) &&
          (s.windows.length
            ? later.windows[0]?.kind === s.windows[0].kind
            : later.windows.length > 0),
      ),
  );
}

export function mergeQuotaEvidence(
  snapshots: CapacitySnapshot[],
  nowS: number,
): CapacitySnapshot | undefined {
  const evidence = retainQuotaEvidence(snapshots, nowS);
  if (!evidence.length) return undefined;
  const selected = new Map<string, CapacitySnapshot>();
  for (const s of evidence) {
    const w = s.windows[0];
    if (!w) continue;
    const old = selected.get(w.kind);
    const live = w.resetsAt === null || w.resetsAt > nowS;
    const oldWindow = old?.windows[0];
    const oldLive = oldWindow && (oldWindow.resetsAt === null || oldWindow.resetsAt > nowS);
    if (
      !old ||
      (live && !oldLive) ||
      (live === !!oldLive && (w.usedRatio ?? -1) > (oldWindow!.usedRatio ?? -1))
    )
      selected.set(w.kind, s);
  }
  const contributing = [...selected.values()];
  const unlocated = evidence.filter((s) => !s.windows.length && s.status === 'rejected');
  contributing.push(...unlocated);
  if (!contributing.length) return evidence.at(-1);
  const latest = contributing.at(-1)!;
  return {
    ...latest,
    observedAt: contributing.some((s) => s.observedAt === null)
      ? null
      : Math.min(...contributing.map((s) => s.observedAt!)),
    confidence: evidence.some((s) => ['low', 'unknown'].includes(s.confidence))
      ? 'low'
      : latest.confidence,
    windows: [...selected.values()].map((s) => s.windows[0]),
    status:
      unlocated.length ||
      contributing.some(
        (s) =>
          s.status === 'rejected' &&
          s.windows.some((w) => w.resetsAt === null || w.resetsAt > nowS),
      )
        ? 'rejected'
        : contributing.some((s) => s.status === 'unknown')
          ? 'unknown'
          : latest.status,
  };
}
