import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LAYOUT_FILE_DIR } from './constants.js';
import type { ExecutorId } from './executors/executor.js';

interface Owner {
  pid: number;
  startIdentity: string;
  executionId: string;
  token: string;
  sessionId?: string;
  child?: { pid: number; startIdentity: string };
  launchPending?: boolean;
}

let ownStartIdentity: string | undefined;

/** Query only a registered PID (including our own), never enumerate host processes. */
export function slotProcessIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid slot PID');
  if (pid === process.pid && ownStartIdentity) return ownStartIdentity;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null;
    throw error;
  }
  if (process.platform === 'win32') {
    const result = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference='Stop'; try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString() } catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw } }`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 },
    ).trim();
    if (!result) return null;
    if (!/^\d+$/.test(result)) throw new Error('Unverifiable slot process identity');
    if (pid === process.pid) ownStartIdentity = result;
    return result;
  }
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const identity = `${fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
      if (pid === process.pid) ownStartIdentity = identity;
      return identity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  throw new Error('Slot process identity unsupported on this platform');
}

export function executorSlotsDirectory(executor: ExecutorId): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, 'executor-slots', executor);
}

function readOwner(file: string): Owner {
  const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as Owner;
  if (
    !Number.isSafeInteger(owner.pid) ||
    !owner.startIdentity ||
    !owner.token ||
    !owner.executionId
  )
    throw new Error('Invalid slot owner; manual recovery required');
  return owner;
}

function createLock(file: string, owner: Owner): (() => void) | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(owner));
    fs.fsyncSync(fd);
  } catch (error) {
    fs.unlinkSync(file);
    throw error;
  } finally {
    fs.closeSync(fd);
  }
  return () => {
    if (readOwner(file).token !== owner.token) throw new Error('Slot ownership changed');
    fs.unlinkSync(file);
  };
}

/** Preserve a complete owner record even if the process crashes during an update. */
function updateSlotOwner(file: string, owner: Owner): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(owner));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (readOwner(file).token !== owner.token) throw new Error('Slot ownership changed');
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

/** Serializes gate + slot allocation per executor across repositories/processes.
 * Recovery is serialized too: two reclaimers must never unlink a new owner's lock.
 * An unverifiable/half-written lock fails closed, as does a crashed recovery helper.
 */
export function withExecutorAdmission<T>(
  executor: ExecutorId,
  executionId: string,
  action: (owner: Owner) => T,
): T | undefined {
  const dir = executorSlotsDirectory(executor);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const owner: Owner = {
    pid: process.pid,
    startIdentity: slotProcessIdentity(process.pid)!,
    executionId,
    token: randomUUID(),
  };
  const guard = path.join(dir, 'admission.lock');
  let release = createLock(guard, owner);
  if (!release) {
    const recover = createLock(path.join(dir, 'recovery.lock'), owner);
    if (!recover) return undefined;
    try {
      if (fs.existsSync(guard)) {
        const old = readOwner(guard);
        if (slotProcessIdentity(old.pid) === old.startIdentity) return undefined;
        fs.unlinkSync(guard);
      }
      release = createLock(guard, owner);
    } finally {
      recover();
    }
  }
  if (!release) return undefined;
  try {
    for (const name of fs.readdirSync(dir).filter((n) => /^\d+\.lock$/.test(n))) {
      const file = path.join(dir, name);
      const old = readOwner(file);
      if (slotProcessIdentity(old.pid) !== old.startIdentity) {
        const childIdentity = old.child ? slotProcessIdentity(old.child.pid) : null;
        const childStopped = old.child
          ? childIdentity === null ||
            (old.child.startIdentity !== 'unverified' && childIdentity !== old.child.startIdentity)
          : !old.launchPending;
        if (childStopped) fs.unlinkSync(file);
      }
    }
    return action(owner);
  } finally {
    release();
  }
}

/** Includes unrecovered/unverifiable slots conservatively. Reading never steals a slot. */
export function readExecutorSlots(executor: ExecutorId): { count: number; sessions: string[] } {
  const dir = executorSlotsDirectory(executor);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d+\.lock$/.test(n));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { count: 0, sessions: [] };
    throw error;
  }
  const sessions: string[] = [];
  for (const name of names) {
    try {
      const owner = readOwner(path.join(dir, name));
      if (owner.sessionId) sessions.push(owner.sessionId);
    } catch {
      /* Still counts while writing or unverifiable. */
    }
  }
  return { count: names.length, sessions };
}

export function acquireExecutorSlot(executor: ExecutorId, limit: number, owner: Owner) {
  if (!Number.isInteger(limit) || limit < 1) return undefined;
  if (readExecutorSlots(executor).count >= limit) return undefined;
  for (let index = 0; index < limit; index++) {
    const file = path.join(executorSlotsDirectory(executor), `${index}.lock`);
    const release = createLock(file, owner);
    if (release)
      return {
        release,
        setSession: (sessionId: string) => {
          owner.sessionId = sessionId;
          updateSlotOwner(file, owner);
        },
        markLaunching: () => {
          // An owner dying between spawn and PID registration cannot prove that
          // no executor exists. Keep that slot for manual recovery.
          owner.launchPending = true;
          updateSlotOwner(file, owner);
        },
        setExecutionProcess: (pid: number) => {
          // A short-lived child can exit between spawn and the OS timestamp query.
          // Drain it through finished; do not abort the Execution on that race.
          let startIdentity: string | null;
          try {
            startIdentity = slotProcessIdentity(pid);
          } catch {
            startIdentity = 'unverified';
          }
          owner.child = { pid, startIdentity: startIdentity ?? 'unverified' };
          owner.launchPending = false;
          updateSlotOwner(file, owner);
        },
      };
  }
  return undefined;
}
