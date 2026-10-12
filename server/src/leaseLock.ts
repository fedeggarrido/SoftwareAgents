import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

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
    throw new Error('Invalid lock owner');
  }
  return owner;
}
const contentionCodes = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY', 'EBADF', 'ENOENT']);
export function isContention(error: unknown): boolean {
  return (
    contentionCodes.has((error as NodeJS.ErrnoException).code ?? '') ||
    (error instanceof Error && error.message === 'Path must stay inside its root')
  );
}
export function assertRegularEntry(entry: string): void {
  try {
    if (fs.lstatSync(entry).isSymbolicLink()) throw new Error('Lock entry is a symlink');
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
function snapshot(file: string, leaseMs: number): LockSnapshot {
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
    obsolete: Date.now() - stat.mtimeMs > leaseMs || !isProcessRunning(owner.pid),
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
function electedReaper(
  dir: string,
  dead: LockOwner,
  owner: string,
  until: number,
  leaseMs: number,
): boolean {
  if (Date.now() >= until) return false;
  const file = path.join(dir, `.reaped-${dead.nonce}.lock`);
  try {
    assertRegularEntry(file);
    fs.writeFileSync(file, owner, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (!isContention(error)) throw error;
    const existing = snapshot(file, leaseMs);
    return existing.obsolete && electedReaper(dir, existing.owner, owner, until, leaseMs);
  }
}

export interface LeaseLockOptions {
  /** Directory that holds the lock and its reaper tombstones; created 0700. */
  dir: string;
  name: string;
  timeoutMs: number;
  leaseMs: number;
  label: string;
}

/** Cooperative lease mutex; never held over network work. Expiry recovers even
 * incomplete ownership or a recycled live PID. Critical sections must be short. */
export function withLeaseLock<T>(options: LeaseLockOptions, action: () => T): T {
  const { dir, timeoutMs, leaseMs } = options;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, options.name);
  const owner = JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() });
  const until = Date.now() + timeoutMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let fd: number;
    try {
      assertRegularEntry(file);
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (error) {
      if (!isContention(error)) throw error;
      try {
        const existing = snapshot(file, leaseMs);
        if (existing.obsolete && electedReaper(dir, existing.owner, owner, until, leaseMs)) {
          const current = snapshot(file, leaseMs);
          if (sameFile(existing.stat, current.stat) && existing.text === current.text) {
            fs.unlinkSync(file);
            continue;
          }
        }
      } catch {
        // Creator/reaper may still be writing, or Windows is deleting the entry.
      }
      if (Date.now() >= until) throw new Error(`${options.label} lock timed out`);
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
