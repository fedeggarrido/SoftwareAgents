import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CapacitySnapshot } from '../../core/src/capacity.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  buildMachineCapacityObservation,
  machineCapacityFile,
  MachineCapacityPublisher,
} from '../src/machineCapacity.js';
import { readSelectionSnapshot } from '../src/quotaCommand.js';
import type { AgentState } from '../src/types.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  // Windows os.homedir() ignores HOME; honor it so tests never touch the real profile.
  return { ...actual, homedir: vi.fn(() => process.env.HOME ?? actual.homedir()) };
});

function agent(id: number, providerId?: string): AgentState {
  return { id, providerId } as unknown as AgentState;
}

const capacity: CapacitySnapshot = {
  provider: 'codex',
  status: 'allowed',
  windows: [{ kind: 'five_hour', usedRatio: 0.4, resetsAt: 2_000 }],
  source: 'codex_session_log',
  confidence: 'high',
  observedAt: 1_000,
};

describe('machine capacity observation (SA-QA-3)', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-capacity-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('counts every tracked session per executor, idle or not, and keeps known capacities', () => {
    const store = new AgentStateStore();
    store.set(1, agent(1, 'claude'));
    store.set(2, agent(2));
    store.set(3, agent(3, 'codex'));
    const observation = buildMachineCapacityObservation(store, { codex: capacity }, 1_000);
    expect(observation).toEqual({
      observedAt: 1_000,
      active: { claude: 2, codex: 1 },
      capacities: { codex: capacity },
    });
  });

  it('publishes atomically to ~/.pixel-agents and the quota gate accepts it', () => {
    const store = new AgentStateStore();
    store.set(1, agent(1, 'codex'));
    const publisher = new MachineCapacityPublisher(
      store,
      () => ({ codex: capacity }),
      () => 1_000_000,
    );
    publisher.publish();
    const file = machineCapacityFile();
    expect(file.startsWith(home)).toBe(true);
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    fs.writeFileSync(
      path.join(home, '.pixel-agents', 'config.json'),
      JSON.stringify({
        projects: {
          softwareagents: {
            autonomyLevel: 'A1',
            allowedExecutors: ['codex'],
            concurrency: { maxExecutions: 2, perExecutor: { codex: 2 } },
          },
        },
      }),
    );
    const operator = { autonomyLevel: 'A1' as const, allowedExecutors: ['codex'] };
    const snapshot = readSelectionSnapshot(operator, 1_010);
    expect(snapshot.active).toEqual({ claude: 0, codex: 1 });
    expect(snapshot.capacities.codex).toEqual(capacity);
    expect(snapshot.machinePolicy?.maxConcurrent).toEqual({ codex: 2 });
  });

  it('goes stale once the office stops publishing, so the gate waits again', () => {
    const store = new AgentStateStore();
    new MachineCapacityPublisher(
      store,
      () => ({}),
      () => 1_000_000,
    ).publish();
    const operator = { autonomyLevel: 'A1' as const, allowedExecutors: ['claude'] };
    expect(readSelectionSnapshot(operator, 1_030).active).toEqual({ claude: 0, codex: 0 });
    expect(readSelectionSnapshot(operator, 1_061).active).toEqual({});
  });

  it('publishes on start, repeats on its interval and stops on dispose', () => {
    vi.useFakeTimers();
    try {
      const store = new AgentStateStore();
      let now = 1_000_000;
      const publisher = new MachineCapacityPublisher(
        store,
        () => ({}),
        () => now,
      );
      publisher.start();
      const read = () =>
        (JSON.parse(fs.readFileSync(machineCapacityFile(), 'utf8')) as { observedAt: number })
          .observedAt;
      expect(read()).toBe(1_000);
      now = 1_015_000;
      vi.advanceTimersByTime(15_000);
      expect(read()).toBe(1_015);
      publisher.dispose();
      now = 1_030_000;
      vi.advanceTimersByTime(15_000);
      expect(read()).toBe(1_015);
    } finally {
      vi.useRealTimers();
    }
  });
});
