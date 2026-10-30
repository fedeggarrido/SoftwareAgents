import * as fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const REMOVE_DEADLINE_MS = 20_000;
const REMOVE_RETRY_MS = 250;

/**
 * Removes a test temp dir that a just-exited process tree may still hold. On Windows
 * the Job Object helper (PowerShell) can keep handles for seconds under full-suite
 * load, so EPERM/EBUSY are retried up to a deadline instead of failing teardown.
 */
export async function removeTempDir(dir: string): Promise<void> {
  const deadline = Date.now() + REMOVE_DEADLINE_MS;
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY') || Date.now() > deadline) throw error;
      await delay(REMOVE_RETRY_MS);
    }
  }
}
