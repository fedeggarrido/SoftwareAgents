import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { CapacitySnapshot } from '../../core/src/capacity.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  LAYOUT_FILE_DIR,
  MACHINE_CAPACITY_FILE_NAME,
  MACHINE_CAPACITY_PUBLISH_MS,
  MACHINE_CAPACITY_RETENTION_S,
} from './constants.js';
import type { ExecutorId } from './executors/executor.js';
import { slotProcessIdentity, stopped } from './executorSlots.js';
import { retryFileOperation } from './fileContention.js';
import { resolveInside } from './pathGuard.js';
import { mergeQuotaEvidence, retainQuotaEvidence } from './quotaEvidence.js';

export interface MachineCapacityObservation {
  observedAt: number;
  publisher: { id: string; pid: number; bootId: string; sequence: number; startIdentity?: string };
  coverage: { scope: 'office'; workspaces: string[]; source: 'office_store' };
  sessions: Record<ExecutorId, string[]>;
  capacities: Partial<Record<ExecutorId, CapacitySnapshot>>;
  evidence?: Partial<Record<ExecutorId, CapacitySnapshot[]>>;
}

/** Legacy path is only a base name; each HTTP owner publishes a separate contribution. */
export function machineCapacityFile(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, MACHINE_CAPACITY_FILE_NAME);
}
export function machineCapacityDirectory(): string {
  return `${machineCapacityFile()}.d`;
}

export function buildMachineCapacityObservation(
  store: AgentStateStore,
  capacities: Partial<Record<ExecutorId, CapacitySnapshot | undefined>>,
  nowS: number,
  publisher: MachineCapacityObservation['publisher'],
  workspaces: string[],
): MachineCapacityObservation {
  const sessions: Record<ExecutorId, string[]> = { claude: [], codex: [] };
  for (const agent of store.values()) {
    const executor =
      agent.providerId === undefined || agent.providerId === 'claude'
        ? 'claude'
        : agent.providerId === 'codex'
          ? 'codex'
          : undefined;
    if (executor) sessions[executor].push(agent.sessionId || `${publisher.id}:agent:${agent.id}`);
  }
  const observed: Partial<Record<ExecutorId, CapacitySnapshot>> = {};
  for (const executor of ['claude', 'codex'] as const) {
    if (capacities[executor]) observed[executor] = capacities[executor];
  }
  return {
    observedAt: nowS,
    publisher,
    coverage: { scope: 'office', workspaces, source: 'office_store' },
    sessions,
    capacities: observed,
  };
}

/** Exclusive unique temp, private POSIX mode, same-directory atomic replacement. */
export function writeMachineCapacityObservation(
  observation: MachineCapacityObservation,
  file: string,
): void {
  retryFileOperation(() => fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }));
  const tmp = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = retryFileOperation(() => fs.openSync(tmp, 'wx', 0o600));
    if (process.platform !== 'win32' && (fs.fstatSync(fd).mode & 0o777) !== 0o600)
      throw new Error('Capacity temporary file must have mode 0600');
    fs.writeFileSync(fd, JSON.stringify(observation));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    retryFileOperation(() => fs.renameSync(tmp, file));
    if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o777) !== 0o600)
      throw new Error('Capacity file must have mode 0600');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    retryFileOperation(() => {
      try {
        fs.unlinkSync(tmp);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
  }
}

const seen = new Map<string, { observedAt: number; sequence: number; monotonic: number }>();

/** Expiry tombstones survive reader restarts, so wall-clock rollback cannot revive
 * a generation already rejected. Publisher starts a new epoch on clock rollback.
 */
export function isFreshMachineObservation(
  observation: MachineCapacityObservation,
  file: string,
  nowS: number,
): boolean {
  const { publisher, observedAt } = observation;
  const key = `${file}:${publisher.bootId}`;
  const old = seen.get(key);
  const monotonic = performance.now();
  const invalidDir = path.join(`${file}.invalid`, publisher.bootId);
  const marker = path.join(invalidDir, String(publisher.sequence));
  // Append-only high-water marks are shared by readers. An older publication
  // cannot become authoritative merely because a different CLI process reads it.
  let accepted: string[] = [];
  try {
    accepted = retryFileOperation(() => {
      try {
        return fs.readdirSync(invalidDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    }).filter((n) => n.startsWith('accepted-'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const prior = accepted.map((name) => {
    const [sequence, at] = name.slice('accepted-'.length).split('_');
    return { sequence: Number(sequence), observedAt: Number(at) };
  });
  const invalid =
    observedAt > nowS + 1 ||
    nowS - observedAt > 60 ||
    prior.some((entry) => entry.observedAt > observedAt || entry.sequence > publisher.sequence) ||
    (old &&
      (observedAt < old.observedAt ||
        publisher.sequence < old.sequence ||
        (publisher.sequence === old.sequence && monotonic - old.monotonic > 60_000)));
  if (invalid) {
    retryFileOperation(() => fs.mkdirSync(invalidDir, { recursive: true, mode: 0o700 }));
    try {
      fs.closeSync(retryFileOperation(() => fs.openSync(marker, 'wx', 0o600)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  if (invalid || fs.existsSync(marker) || observedAt > nowS + 1) return false;
  fs.mkdirSync(invalidDir, { recursive: true, mode: 0o700 });
  const acceptedFile = path.join(invalidDir, `accepted-${publisher.sequence}_${observedAt}`);
  try {
    fs.closeSync(retryFileOperation(() => fs.openSync(acceptedFile, 'wx', 0o600)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!old || publisher.sequence > old.sequence)
    seen.set(key, { observedAt, sequence: publisher.sequence, monotonic });
  return true;
}

export class MachineCapacityPublisher {
  private timer: NodeJS.Timeout | undefined;
  private warned = false;
  private bootId = randomUUID();
  private sequence = 0;
  private lastObservedAt = -Infinity;
  private evidence: Partial<Record<ExecutorId, CapacitySnapshot[]>> = {};
  readonly file: string;

  constructor(
    private readonly store: AgentStateStore,
    private readonly capacities: () => Partial<Record<ExecutorId, CapacitySnapshot | undefined>>,
    private readonly now: () => number = Date.now,
    file?: string,
    private readonly workspaces: string[] = [process.cwd()],
    private readonly ownsServer: () => boolean = () => false,
  ) {
    this.file = file ?? path.join(machineCapacityDirectory(), `${process.pid}-${this.bootId}.json`);
  }

  start(): void {
    if (!this.ownsServer() || this.timer) return;
    try {
      collectDeadMachinePublishers(this.now() / 1000);
    } catch (error) {
      console.warn('[Pixel Agents] Could not collect dead machine publishers:', error);
    }
    this.publish();
    this.timer = setInterval(() => this.publish(), MACHINE_CAPACITY_PUBLISH_MS);
    this.timer.unref();
  }
  publish(): void {
    if (!this.ownsServer()) return;
    try {
      const nowS = this.now() / 1000;
      if (nowS < this.lastObservedAt) {
        this.bootId = randomUUID();
        this.sequence = 0;
      }
      const capacities = this.capacities();
      const combined: Partial<Record<ExecutorId, CapacitySnapshot>> = {};
      for (const executor of ['claude', 'codex'] as const) {
        this.evidence[executor] = retainQuotaEvidence(
          [...(this.evidence[executor] ?? []), capacities[executor]].filter(
            (s): s is CapacitySnapshot => !!s,
          ),
          nowS,
        );
        combined[executor] = mergeQuotaEvidence(this.evidence[executor]!, nowS);
      }
      const observation = buildMachineCapacityObservation(
        this.store,
        combined,
        nowS,
        {
          id: this.bootId,
          pid: process.pid,
          bootId: this.bootId,
          sequence: ++this.sequence,
          startIdentity: slotProcessIdentity(process.pid) ?? undefined,
        },
        this.workspaces,
      );
      observation.evidence = this.evidence;
      writeMachineCapacityObservation(observation, this.file);
      this.lastObservedAt = nowS;
      this.warned = false;
    } catch (error) {
      if (!this.warned) console.warn('[Pixel Agents] Could not publish machine capacity:', error);
      this.warned = true;
    }
  }
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** Remove lexical entries without following links, including nested junctions.
 * resolveInside contains every ordinary entry; lstat distinguishes links first.
 * The private operator-owned directory must not be concurrently replaced by links.
 */
function removePublisherEntry(root: string, name: string): void {
  const lexical = path.join(root, name);
  const stat = retryFileOperation(() => fs.lstatSync(lexical));
  if (stat.isSymbolicLink()) {
    retryFileOperation(() => fs.unlinkSync(lexical));
    return;
  }
  const file = resolveInside(root, name);
  if (stat.isDirectory()) {
    for (const child of retryFileOperation(() => fs.readdirSync(file)))
      removePublisherEntry(file, child);
    retryFileOperation(() => fs.rmdirSync(file));
  } else retryFileOperation(() => fs.unlinkSync(file));
}

/** Unknown identity/EPERM, malformed or recent publications confer no GC authority. */
export function collectDeadMachinePublishers(nowS: number): void {
  if (!Number.isFinite(nowS)) return;
  const home = os.homedir();
  const configDir = path.join(home, LAYOUT_FILE_DIR);
  const directory = machineCapacityDirectory();
  // A linked publication root must never redirect garbage collection elsewhere.
  for (const dir of [configDir, directory]) {
    try {
      const stat = retryFileOperation(() => fs.lstatSync(dir));
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  resolveInside(home, LAYOUT_FILE_DIR + '/' + MACHINE_CAPACITY_FILE_NAME + '.d');
  for (const name of retryFileOperation(() => fs.readdirSync(directory))) {
    if (!name.endsWith('.json')) continue;
    try {
      const lexical = path.join(directory, name);
      const stat = retryFileOperation(() => fs.lstatSync(lexical));
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      const file = resolveInside(directory, name);
      const content = retryFileOperation(() => fs.readFileSync(file, 'utf8'));
      const observation = JSON.parse(content) as MachineCapacityObservation;
      const p = observation?.publisher;
      if (
        !Number.isFinite(observation?.observedAt) ||
        nowS - observation.observedAt <= MACHINE_CAPACITY_RETENTION_S ||
        !p ||
        !Number.isSafeInteger(p.pid) ||
        p.pid <= 0 ||
        typeof p.bootId !== 'string' ||
        !/^[a-zA-Z0-9-]+$/.test(p.bootId) ||
        (p.startIdentity !== undefined && (typeof p.startIdentity !== 'string' || !p.startIdentity))
      )
        continue;
      try {
        process.kill(p.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
      }
      const dead = p.startIdentity
        ? stopped(p.pid, p.startIdentity)
        : slotProcessIdentity(p.pid) === null;
      if (!dead) continue;
      // Recheck the exact generation before deleting its publication and tombstones.
      if (
        retryFileOperation(() => fs.lstatSync(file)).isSymbolicLink() ||
        retryFileOperation(() => fs.readFileSync(file, 'utf8')) !== content
      )
        continue;
      const invalidName = name + '.invalid';
      const invalid = path.join(directory, invalidName);
      try {
        const invalidStat = retryFileOperation(() => fs.lstatSync(invalid));
        if (invalidStat.isSymbolicLink()) removePublisherEntry(directory, invalidName);
        else if (invalidStat.isDirectory()) {
          const contained = resolveInside(directory, invalidName);
          try {
            removePublisherEntry(contained, p.bootId);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          if (!retryFileOperation(() => fs.readdirSync(contained)).length)
            retryFileOperation(() => fs.rmdirSync(contained));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      retryFileOperation(() => fs.unlinkSync(file));
      seen.delete(file + ':' + p.bootId);
    } catch {
      // Malformed data, links, concurrent cleanup and persistent contention are kept safely.
    }
  }
}
