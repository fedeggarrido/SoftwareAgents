import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LAYOUT_FILE_DIR } from './constants.js';
import type { ExecutorId } from './executors/executor.js';
import { withoutOperatorToken } from './featureIngress.js';
import {
  contentionNow,
  contentionPause,
  isFileContention,
  retryFileOperation,
} from './fileContention.js';

interface Owner {
  pid: number;
  startIdentity: string;
  executionId: string;
  token: string;
  sessionId?: string;
  child?: { pid: number; startIdentity: string };
  launchPending?: boolean;
  launchProtocol?: 'registered_wrapper';
}
export const INCOMPLETE_LOCK_LEASE_MS = 10_000;
let ownStartIdentity: string | undefined;
const incompleteLeases = new Map<string, { stamp: string; at: number }>();
const processIdentities = new Map<number, { identity: string; at: number }>();

/** null = dead; undefined = alive but unverifiable. Query registered PIDs only. */
export function slotProcessIdentity(pid: number): string | null | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (pid === process.pid && ownStartIdentity) return ownStartIdentity;
  const dead = () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  };
  if (dead()) {
    processIdentities.delete(pid);
    return null;
  }
  const cached = processIdentities.get(pid);
  if (cached && contentionNow() - cached.at < 30_000) return cached.identity;
  try {
    let identity: string;
    if (process.platform === 'win32') {
      identity = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference='Stop'; try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString() } catch { $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().Ticks.ToString() } }`,
        ],
        {
          env: withoutOperatorToken(process.env),
          encoding: 'utf8',
          windowsHide: true,
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ).trim();
      if (!/^\d+$/.test(identity)) return dead() ? null : undefined;
    } else if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      if (!start || !/^\d+$/.test(start)) return undefined;
      identity = `${fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${start}`;
    } else {
      // Darwin/BSD: ps is locale-stable, second precision. Never enumerate processes.
      identity = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 5000,
        env: withoutOperatorToken({ ...process.env, LC_ALL: 'C' }),
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!identity) return dead() ? null : undefined;
    }
    processIdentities.set(pid, { identity, at: contentionNow() });
    if (pid === process.pid) ownStartIdentity = identity;
    return identity;
  } catch {
    return dead() ? null : undefined;
  }
}

export function executorSlotsDirectory(executor: ExecutorId): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, 'executor-slots', executor);
}
function readOwner(file: string): Owner | undefined {
  try {
    const owner = JSON.parse(
      retryFileOperation(() => {
        try {
          return fs.readFileSync(file, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
          throw error;
        }
      }),
    ) as Owner;
    if (
      !owner ||
      typeof owner !== 'object' ||
      !Number.isSafeInteger(owner.pid) ||
      typeof owner.startIdentity !== 'string' ||
      !owner.startIdentity ||
      !owner.token ||
      !owner.executionId
    )
      return undefined;
    return owner;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
function unlink(file: string): void {
  incompleteLeases.delete(file);
  retryFileOperation(() => {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  });
}
function writeExclusive(file: string, data: unknown): boolean {
  let fd: number;
  try {
    fd = retryFileOperation(() => fs.openSync(file, 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  let failed = false;
  try {
    fs.writeFileSync(fd, JSON.stringify(data));
    fs.fsyncSync(fd);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      fs.closeSync(fd);
    } finally {
      if (failed) unlink(file);
    }
  }
  return true;
}
function createLock(file: string, owner: Owner): (() => void) | undefined {
  if (!writeExclusive(file, owner)) return undefined;
  return () => {
    const current = readOwner(file);
    if (!current || current.token !== owner.token)
      throw new Error(`Slot ownership unverifiable: ${file}`);
    unlink(file);
  };
}
/** A failed replacement leaves the complete previous record intact. */
function updateSlotOwner(file: string, owner: Owner): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeExclusive(tmp, owner);
    if (readOwner(file)?.token !== owner.token) throw new Error(`Slot ownership changed: ${file}`);
    retryFileOperation(() => fs.renameSync(tmp, file));
  } finally {
    unlink(tmp);
  }
}
export function stopped(pid: number, identity: string): boolean {
  let current = slotProcessIdentity(pid);
  // A cached previous lifetime cannot prove a newly registered owner is dead.
  if (current !== null && current !== undefined && current !== identity) {
    processIdentities.delete(pid);
    current = slotProcessIdentity(pid);
  }
  return (
    current === null || (current !== undefined && identity !== 'unverified' && current !== identity)
  );
}
function incompleteExpired(file: string): boolean {
  try {
    const stat = retryFileOperation(() => {
      try {
        return fs.statSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    });
    if (!stat) return true; // Gone contenders must not stall the next directory sweep.
    const wallNow = Date.now();
    // Persist a fresh lease after wall-clock rollback, including across short-lived
    // CLI readers. This is only reached for incomplete records, never live owners.
    if (stat.mtimeMs > wallNow)
      retryFileOperation(() => fs.utimesSync(file, new Date(wallNow), new Date(wallNow)));
    const stamp = String(stat.ino) + ':' + stat.mtimeMs + ':' + stat.size;
    const old = incompleteLeases.get(file);
    if (!old || old.stamp !== stamp) incompleteLeases.set(file, { stamp, at: contentionNow() });
    return (
      wallNow - stat.mtimeMs > INCOMPLETE_LOCK_LEASE_MS ||
      contentionNow() - incompleteLeases.get(file)!.at > INCOMPLETE_LOCK_LEASE_MS
    );
  } catch (error) {
    if (isFileContention(error)) return false;
    throw error;
  }
}

const held = new Set<ExecutorId>();
/** Lamport bakery admission: unique per-attempt files avoid shared recovery-lock ABA.
 * The claim (choosing) precedes its immutable ticket. New arrivals see our ticket;
 * existing choosers must finish before entry. Dead/incomplete claims can be leased
 * out without ever unlinking another generation. Numbered slots are swept only
 * under admission. Same-process reentrancy returns busy rather than deadlocking.
 */
export function withExecutorAdmission<T>(
  executor: ExecutorId,
  executionId: string,
  action: (owner: Owner) => T,
): T | undefined {
  if (held.has(executor)) return undefined;
  const dir = executorSlotsDirectory(executor);
  retryFileOperation(() => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }));
  const identity = slotProcessIdentity(process.pid);
  if (!identity) throw new Error(`Cannot verify admission owner: ${dir}`);
  const owner: Owner = {
    pid: process.pid,
    startIdentity: identity,
    executionId,
    token: randomUUID(),
  };
  const claim = path.join(dir, `${owner.token}.claim`);
  const ready = `${claim}.ready`;
  writeExclusive(claim, owner);
  const deadline = contentionNow() + 1500;
  const identities = new Map<string, boolean>();
  const deadOwner = (o: Owner) => {
    const key = `${o.pid}:${o.startIdentity}`;
    if (!identities.has(key)) identities.set(key, stopped(o.pid, o.startIdentity));
    return identities.get(key)!;
  };
  const tickets = () => {
    const result: { file: string; owner: Owner | undefined; rank: number | undefined }[] = [];
    for (const name of retryFileOperation(() => fs.readdirSync(dir)).filter((n) =>
      n.endsWith('.claim'),
    )) {
      const file = path.join(dir, name);
      const other = readOwner(file);
      if (file !== claim && ((other && deadOwner(other)) || (!other && incompleteExpired(file)))) {
        unlink(`${file}.ready`);
        unlink(file);
        continue;
      }
      let rank: number | undefined;
      let incompleteTicket = false;
      try {
        const value = JSON.parse(fs.readFileSync(`${file}.ready`, 'utf8'));
        if (Number.isSafeInteger(value) && value > 0) rank = value;
      } catch (error) {
        if (!(error instanceof SyntaxError) && !isFileContention(error)) throw error;
        incompleteTicket =
          error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT';
      }
      if (file !== claim && incompleteTicket && incompleteExpired(file)) {
        unlink(file);
        unlink(`${file}.ready`);
        continue;
      }
      result.push({ file, owner: other, rank });
    }
    return result;
  };
  try {
    const rank = 1 + Math.max(0, ...tickets().map((t) => t.rank ?? 0));
    writeExclusive(ready, rank);
    for (;;) {
      // Legacy fixed admission files are only read/recovered; new code never creates them.
      let busy = false;
      for (const name of ['admission.lock', 'recovery.lock']) {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) continue;
        const old = readOwner(file);
        if ((old && deadOwner(old)) || (!old && incompleteExpired(file))) unlink(file);
        else busy = true;
      }
      const waiting = tickets();
      if (!waiting.some((t) => t.file === claim && t.owner?.token === owner.token))
        return undefined;
      busy ||= waiting.some(
        (t) =>
          t.file !== claim &&
          (t.owner === undefined ||
            t.rank === undefined ||
            t.rank < rank ||
            (t.rank === rank && t.file < claim)),
      );
      if (!busy) break;
      if (contentionNow() >= deadline) return undefined;
      contentionPause();
    }
    held.add(executor);
    for (const name of fs.readdirSync(dir).filter((n) => /^\d+\.lock$/.test(n))) {
      const file = path.join(dir, name);
      const old = readOwner(file);
      if (!old) {
        if (incompleteExpired(file)) unlink(file);
        continue;
      }
      if (
        deadOwner(old) &&
        (old.child
          ? stopped(old.child.pid, old.child.startIdentity)
          : !old.launchPending || old.launchProtocol === 'registered_wrapper')
      )
        unlink(file);
    }
    return action(owner);
  } catch (error) {
    if (isFileContention(error)) return undefined;
    throw error;
  } finally {
    held.delete(executor);
    // Delete the choosing record first; an orphan ticket is never a contender.
    unlink(claim);
    unlink(ready);
  }
}
/** Reading never steals a slot. Incomplete/unverifiable records still reserve capacity. */
export function readExecutorSlots(executor: ExecutorId): {
  count: number;
  sessions: string[];
  blocked: string[];
} {
  const dir = executorSlotsDirectory(executor);
  let names: string[];
  try {
    names = retryFileOperation(() => {
      try {
        return fs.readdirSync(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    }).filter((n) => /^\d+\.lock$/.test(n));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { count: 0, sessions: [], blocked: [] };
    throw error;
  }
  const sessions: string[] = [],
    blocked: string[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let owner: Owner | undefined;
    try {
      owner = readOwner(file);
    } catch (error) {
      if (!isFileContention(error)) throw error;
    }
    if (owner?.sessionId) sessions.push(owner.sessionId);
    if (!owner || owner.launchPending || slotProcessIdentity(owner.pid) === undefined)
      blocked.push(file);
  }
  return { count: names.length, sessions, blocked };
}
/** All worker paths hold both admissions in this order before counting/reserving. */
export function withMachineAdmission<T>(
  executionId: string,
  action: (owners: Record<ExecutorId, Owner>) => T,
): T | undefined {
  return withExecutorAdmission('claude', executionId, (claude) =>
    withExecutorAdmission('codex', executionId, (codex) => action({ claude, codex })),
  );
}
export function acquireExecutorSlot(
  executor: ExecutorId,
  limit: number,
  owner: Owner,
  maxExecutions?: number,
) {
  if (
    maxExecutions !== undefined &&
    (!held.has('claude') ||
      !held.has('codex') ||
      !Number.isInteger(maxExecutions) ||
      maxExecutions < 0 ||
      readExecutorSlots('claude').count + readExecutorSlots('codex').count >= maxExecutions)
  )
    return undefined;
  if (!Number.isInteger(limit) || limit < 1) return undefined;
  if (readExecutorSlots(executor).count >= limit) return undefined;
  for (let index = 0; index < limit; index++) {
    const file = path.join(executorSlotsDirectory(executor), `${index}.lock`);
    const release = createLock(file, owner);
    if (release)
      return {
        release,
        setSession: (sessionId: string) => {
          updateSlotOwner(file, { ...owner, sessionId });
          owner.sessionId = sessionId;
        },
        markLaunching: (launchProtocol?: 'registered_wrapper') => {
          updateSlotOwner(file, { ...owner, launchPending: true, launchProtocol });
          owner.launchPending = true;
          owner.launchProtocol = launchProtocol;
        },
        setExecutionProcess: (pid: number) => {
          const startIdentity = slotProcessIdentity(pid);
          // The wrapper cannot be allowed to spawn with unverifiable identity.
          if (!startIdentity) throw new Error(`Cannot verify launch process; slot: ${file}`);
          const next = { ...owner, child: { pid, startIdentity }, launchPending: false };
          updateSlotOwner(file, next);
          Object.assign(owner, next);
        },
      };
  }
  return undefined;
}
