import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SERVER_DISCOVERY_LOCK_TIMEOUT_MS, SERVER_JSON_DIR, SERVERS_DIR } from './constants.js';
import { resolveInside } from './pathGuard.js';
import type { ServerTarget } from './serverConfig.js';

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

export function discoveryRoot(): string {
  return path.join(os.homedir(), SERVER_JSON_DIR);
}

/** Physical containment is checked again immediately before every mutation. */
export function discoveryPath(relative: string): string {
  return resolveInside(discoveryRoot(), relative);
}

/** EPERM means a process exists; only ESRCH proves its owner died. */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

interface LockOwner {
  pid: number;
  nonce: string;
}
function readLockOwner(text: string): LockOwner {
  const owner = JSON.parse(text) as LockOwner;
  if (
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.nonce !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(owner.nonce)
  ) {
    throw new Error('Invalid discovery lock owner');
  }
  return owner;
}

/**
 * Elect exactly one reaper per dead generation. Keep its tiny tombstone: deleting
 * it could let a delayed second reaper unlink a newly acquired main lock. If a
 * reaper itself died, elect a successor using that reaper's unique generation.
 */
function electedReaper(dead: LockOwner, owner: string, until: number): boolean {
  if (Date.now() >= until) return false;
  const relative = `${SERVERS_DIR}/.reaped-${dead.nonce}.lock`;
  try {
    fs.writeFileSync(discoveryPath(relative), owner, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const reaper = readLockOwner(fs.readFileSync(discoveryPath(relative), 'utf8'));
    return !isProcessRunning(reaper.pid) && electedReaper(reaper, owner, until);
  }
}

/**
 * Short cooperative cross-process mutex for publication and compare/delete.
 * Never held during HTTP probes. A live owner is never evicted; contention or
 * unreadable/incomplete ownership fails closed after a bounded wait.
 */
export function withDiscoveryLock<T>(action: () => T): T {
  fs.mkdirSync(discoveryRoot(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(discoveryPath(SERVERS_DIR), { recursive: true, mode: 0o700 });
  const relative = `${SERVERS_DIR}/.discovery.lock`;
  const owner = JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() });
  const until = Date.now() + SERVER_DISCOVERY_LOCK_TIMEOUT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let fd: number;
    try {
      fd = fs.openSync(discoveryPath(relative), 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const lockPath = discoveryPath(relative);
        const text = fs.readFileSync(lockPath, 'utf8');
        const existing = readLockOwner(text);
        if (
          !isProcessRunning(existing.pid) &&
          electedReaper(existing, owner, until) &&
          fs.readFileSync(discoveryPath(relative), 'utf8') === text
        ) {
          fs.unlinkSync(discoveryPath(relative));
          continue;
        }
      } catch {
        // A creator may still be writing its ownership record. Do not evict it.
      }
      if (Date.now() >= until) throw new Error('Discovery lock timed out');
      Atomics.wait(pause, 0, 0, Math.min(10, until - Date.now()));
      continue;
    }
    try {
      fs.writeFileSync(fd, owner);
      return action();
    } finally {
      fs.closeSync(fd);
      if (fs.readFileSync(discoveryPath(relative), 'utf8') === owner) {
        fs.unlinkSync(discoveryPath(relative));
      }
    }
  }
}

/** Must be called under the discovery lock. Unique exclusive temporary + rename. */
export function writeDiscoveryRecord(relative: string, config: ServerTarget): void {
  const temp = `${relative}.${crypto.randomUUID()}.tmp`;
  let created = false;
  try {
    const fd = fs.openSync(discoveryPath(temp), 'wx', 0o600);
    created = true;
    try {
      fs.writeFileSync(fd, JSON.stringify(config, null, 2));
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(discoveryPath(temp), discoveryPath(relative));
  } finally {
    if (created && fs.existsSync(discoveryPath(temp))) fs.unlinkSync(discoveryPath(temp));
  }
}
