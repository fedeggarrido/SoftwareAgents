import type { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';

/** SQLite can skip its busy handler to avoid deadlock, notably while switching to WAL. */
export async function retryBusy<T>(
  db: DatabaseSync,
  deadline: number,
  operation: () => T,
): Promise<T> {
  let backoff = 5;
  for (;;) {
    const remaining = Math.max(0, Math.floor(deadline - performance.now()));
    db.exec(`PRAGMA busy_timeout = ${remaining}`);
    try {
      return operation();
    } catch (error) {
      const code = (error as { errcode?: unknown } | null)?.errcode;
      // node:sqlite uses ERR_SQLITE_ERROR for many failures. Inspect the SQLite
      // primary result code, including extended BUSY/LOCKED result codes.
      if (typeof code !== 'number' || ![5, 6].includes(code & 0xff)) throw error;
      const timeLeft = deadline - performance.now();
      if (timeLeft <= 0) throw error;
      await setTimeout(Math.min(backoff, timeLeft));
      if (performance.now() >= deadline) throw error;
      backoff = Math.min(backoff * 2, 100);
    }
  }
}
