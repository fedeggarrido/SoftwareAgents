import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  SERVER_DISCOVERY_LOCK_LEASE_MS,
  SERVER_DISCOVERY_LOCK_TIMEOUT_MS,
  SERVER_DISCOVERY_RENAME_TIMEOUT_MS,
  SERVER_JSON_DIR,
  SERVERS_DIR,
} from './constants.js';
import { assertRegularEntry, isProcessRunning, withLeaseLock } from './leaseLock.js';
import { resolveInside } from './pathGuard.js';
import type { ServerTarget } from './serverConfig.js';

export { isProcessRunning };

/** Exact instance identity, including legacy records which omit startedAt. */
export function sameServerGeneration(a: ServerTarget, b: ServerTarget): boolean {
  return (
    a.pid === b.pid &&
    a.port === b.port &&
    a.token === b.token &&
    a.startedAt === b.startedAt &&
    a.host === b.host
  );
}
export function discoveryRoot(home = os.homedir()): string {
  return path.join(home, SERVER_JSON_DIR);
}
export function discoveryPath(relative: string): string {
  return resolveInside(discoveryRoot(), relative);
}
/** Contain the parent, then operate on the lexical entry, never a link target. */
export function discoveryEntryPath(relative: string, home?: string): string {
  const parent = path.dirname(relative);
  const dir =
    parent === '.'
      ? fs.realpathSync.native(discoveryRoot(home))
      : resolveInside(discoveryRoot(home), parent);
  const entry = path.join(dir, path.basename(relative));
  assertRegularEntry(entry);
  return entry;
}
/** Cooperative lease mutex for discovery publication and cleanup (see leaseLock). */
export function withDiscoveryLock<T>(action: () => T): T {
  fs.mkdirSync(discoveryRoot(), { recursive: true, mode: 0o700 });
  // Resolve once: Windows may realpath a delete-pending lock into $Deleted.
  return withLeaseLock(
    {
      dir: discoveryPath(SERVERS_DIR),
      name: '.discovery.lock',
      timeoutMs: SERVER_DISCOVERY_LOCK_TIMEOUT_MS,
      leaseMs: SERVER_DISCOVERY_LOCK_LEASE_MS,
      label: 'Discovery',
    },
    action,
  );
}
/** Under the discovery lock. Exclusive temporary + lexical rename. */
export function writeDiscoveryRecord(relative: string, config: ServerTarget): void {
  const temp = `${relative}.${crypto.randomUUID()}.tmp`;
  let created = false;
  try {
    const fd = fs.openSync(discoveryEntryPath(temp), 'wx', 0o600);
    created = true;
    try {
      fs.writeFileSync(fd, JSON.stringify(config, null, 2));
    } finally {
      fs.closeSync(fd);
    }
    const until = Date.now() + SERVER_DISCOVERY_RENAME_TIMEOUT_MS;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    let delay = 1;
    for (;;) {
      try {
        fs.renameSync(discoveryEntryPath(temp), discoveryEntryPath(relative));
        break;
      } catch (error) {
        if (
          !['EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') ||
          Date.now() >= until
        )
          throw error;
        Atomics.wait(pause, 0, 0, Math.min(delay, until - Date.now()));
        delay = Math.min(delay * 2, 20);
      }
    }
  } finally {
    if (created) {
      const file = discoveryEntryPath(temp);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
}
