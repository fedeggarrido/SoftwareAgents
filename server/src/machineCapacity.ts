import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { CapacitySnapshot } from '../../core/src/capacity.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  LAYOUT_FILE_DIR,
  MACHINE_CAPACITY_FILE_NAME,
  MACHINE_CAPACITY_PUBLISH_MS,
} from './constants.js';
import type { ExecutorId } from './executors/executor.js';

export interface MachineCapacityObservation {
  observedAt: number;
  active: Record<ExecutorId, number>;
  capacities: Partial<Record<ExecutorId, CapacitySnapshot>>;
}

export function machineCapacityFile(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, MACHINE_CAPACITY_FILE_NAME);
}

/**
 * What the quota gate (SA-036) reads as the machine-wide observation. Every session
 * this office tracks counts as active, idle or not: over-counting only makes the gate
 * wait, while under-counting would let it launch past the operator's cap. Sessions the
 * office does not watch (other workspaces without Watch All Sessions) are invisible
 * here; docs/executor-selection.md states that scope.
 */
export function buildMachineCapacityObservation(
  store: AgentStateStore,
  capacities: Partial<Record<ExecutorId, CapacitySnapshot | undefined>>,
  nowS: number,
): MachineCapacityObservation {
  const active: Record<ExecutorId, number> = { claude: 0, codex: 0 };
  for (const agent of store.values()) active[agent.providerId === 'codex' ? 'codex' : 'claude']++;
  const observed: Partial<Record<ExecutorId, CapacitySnapshot>> = {};
  for (const executor of ['claude', 'codex'] as const) {
    const snapshot = capacities[executor];
    if (snapshot) observed[executor] = snapshot;
  }
  return { observedAt: nowS, active, capacities: observed };
}

/** Atomic tmp + rename, so a reader never sees a half-written observation. */
export function writeMachineCapacityObservation(
  observation: MachineCapacityObservation,
  file = machineCapacityFile(),
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(observation), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Publishes the observation while the office runs. When the server stops, the file
 * simply ages past the gate's 60 s limit and the gate waits again: no cleanup needed,
 * and a crash cannot leave a fresh-looking observation behind.
 */
export class MachineCapacityPublisher {
  private timer: NodeJS.Timeout | undefined;
  private warned = false;

  constructor(
    private readonly store: AgentStateStore,
    private readonly capacities: () => Partial<Record<ExecutorId, CapacitySnapshot | undefined>>,
    private readonly now: () => number = Date.now,
    private readonly file = machineCapacityFile(),
  ) {}

  start(): void {
    this.publish();
    this.timer = setInterval(() => this.publish(), MACHINE_CAPACITY_PUBLISH_MS);
    this.timer.unref();
  }

  publish(): void {
    try {
      writeMachineCapacityObservation(
        buildMachineCapacityObservation(this.store, this.capacities(), this.now() / 1000),
        this.file,
      );
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
