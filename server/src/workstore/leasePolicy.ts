export const DEFAULT_LEASE_TTL_MS = 60_000;
export const LEASE_SWEEP_INTERVAL_MS = 5_000;

export function leaseDeadline(owner: string, ttl: number): string {
  if (!owner.trim() || !Number.isSafeInteger(ttl) || ttl <= 0)
    throw new Error('Lease requires a nonempty owner and positive integer TTL in milliseconds');
  const deadline = new Date(Date.now() + ttl);
  if (!Number.isFinite(deadline.getTime())) throw new Error('Lease TTL is out of range');
  return deadline.toISOString();
}
