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
    !/^(?:[a-f0-9-]{36}|[a-f0-9]{64})$/.test(owner.nonce)
  ) {
    throw new Error('Invalid discovery lock owner');
  }
  return owner;
}
const contentionCodes = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY', 'EBADF', 'ENOENT']);
function isContention(error: unknown): boolean {
  return (
    contentionCodes.has((error as NodeJS.ErrnoException).code ?? '') ||
    (error instanceof Error && error.message === 'Path must stay inside its root')
  );
}
/** Contain the parent, then operate on the lexical entry, never a link target. */
export function discoveryEntryPath(relative: string): string {
  const parent = path.dirname(relative);
  const dir = parent === '.' ? fs.realpathSync.native(discoveryRoot()) : discoveryPath(parent);
  const entry = path.join(dir, path.basename(relative));
  assertRegularEntry(entry);
  return entry;
}
function assertRegularEntry(entry: string): void {
  try {
    if (fs.lstatSync(entry).isSymbolicLink()) throw new Error('Discovery entry is a symlink');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
interface LockSnapshot {
  stat: fs.Stats;
  text: string;
  owner: LockOwner;
  obsolete: boolean;
}
function snapshot(file: string): LockSnapshot {
  assertRegularEntry(file);
  const stat = fs.lstatSync(file);
  const text = fs.readFileSync(file, 'utf8');
  let owner: LockOwner;
  try {
    owner = readLockOwner(text);
  } catch {
    // Deterministic generation for an empty/partial file, independent of PID.
    owner = {
      pid: process.pid,
      nonce: crypto
        .createHash('sha256')
        .update(`${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${text}`)
        .digest('hex'),
    };
  }
  return {
    stat,
    text,
    owner,
    obsolete:
      Date.now() - stat.mtimeMs > SERVER_DISCOVERY_LOCK_LEASE_MS || !isProcessRunning(owner.pid),
  };
}
function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.ctimeMs === b.ctimeMs &&
    a.mtimeMs === b.mtimeMs &&
    a.size === b.size
  );
}
/** One reaper per generation. Expired/corrupt/dead reapers elect successors;
 * tombstones remain so a delayed loser cannot unlink a newly acquired lock. */
function electedReaper(dir: string, dead: LockOwner, owner: string, until: number): boolean {
  if (Date.now() >= until) return false;
  const file = path.join(dir, `.reaped-${dead.nonce}.lock`);
  try {
    assertRegularEntry(file);
    fs.writeFileSync(file, owner, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (!isContention(error)) throw error;
    const existing = snapshot(file);
    return existing.obsolete && electedReaper(dir, existing.owner, owner, until);
  }
}
/** Cooperative lease mutex; never held over HTTP work. Expiry recovers even
 * incomplete ownership or a recycled live PID. Critical sections must be short. */
export function withDiscoveryLock<T>(action: () => T): T {
  fs.mkdirSync(discoveryRoot(), { recursive: true, mode: 0o700 });
  // Resolve once: Windows may realpath a delete-pending lock into $Deleted.
  const dir = discoveryPath(SERVERS_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, '.discovery.lock');
  const owner = JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() });
  const until = Date.now() + SERVER_DISCOVERY_LOCK_TIMEOUT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let fd: number;
    try {
      assertRegularEntry(file);
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (error) {
      if (!isContention(error)) throw error;
      try {
        const existing = snapshot(file);
        if (existing.obsolete && electedReaper(dir, existing.owner, owner, until)) {
          const current = snapshot(file);
          if (sameFile(existing.stat, current.stat) && existing.text === current.text) {
            fs.unlinkSync(file);
            continue;
          }
        }
      } catch {
        // Creator/reaper may still be writing, or Windows is deleting the entry.
      }
      if (Date.now() >= until) throw new Error('Discovery lock timed out');
      Atomics.wait(pause, 0, 0, Math.min(10, until - Date.now()));
      continue;
    }
    let acquired: fs.Stats | undefined;
    try {
      fs.writeFileSync(fd, owner);
      acquired = fs.fstatSync(fd);
      return action();
    } finally {
      // wx grants ownership even if body write/read fails. Do not reread it.
      // After lease expiry a successor may own this name: preserve its inode.
      try {
        acquired ??= fs.fstatSync(fd);
      } finally {
        try {
          fs.closeSync(fd);
        } finally {
          try {
            assertRegularEntry(file);
            const current = fs.lstatSync(file);
            if (
              acquired &&
              acquired.dev === current.dev &&
              acquired.ino === current.ino &&
              acquired.birthtimeMs === current.birthtimeMs
            )
              fs.unlinkSync(file);
          } catch (error) {
            if (!isContention(error)) throw error;
          }
        }
      }
    }
  }
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
