import { spawn } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import {
  acquireExecutorSlot,
  executorSlotsDirectory,
  readExecutorSlots,
  slotProcessIdentity,
  withExecutorAdmission,
} from '../src/executorSlots.js';
import { MachineCapacityPublisher } from '../src/machineCapacity.js';
import { readSelectionSnapshot } from '../src/quotaCommand.js';
import { quotaGate } from '../src/quotaGate.js';
import type { AgentState } from '../src/types.js';

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => process.env.HOME ?? actual.homedir()) };
});
let home: string;
const operator = {
  autonomyLevel: 'A1' as const,
  allowedExecutors: ['codex'],
  quotaThresholds: { codex: 10 },
  concurrency: { maxExecutions: 2, perExecutor: { codex: 2 } },
};
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-slots-'));
  vi.stubEnv('HOME', home);
  fs.mkdirSync(path.join(home, '.pixel-agents'));
  fs.writeFileSync(
    path.join(home, '.pixel-agents/config.json'),
    JSON.stringify({ projects: { test: operator } }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});
it('serializes admission, holds slots until release, and rejects probes while another slot is held', () => {
  const slot = withExecutorAdmission('codex', 'execution-a', (owner) => {
    expect(withExecutorAdmission('codex', 'execution-b', () => true)).toBeUndefined();
    return acquireExecutorSlot('codex', 1, owner)!;
  })!;
  expect(readExecutorSlots('codex').count).toBe(1);
  const s = readSelectionSnapshot(operator, 1000);
  expect(
    quotaGate('codex', s.machinePolicy, s.capacities.codex, s.active.codex!, 1000).status,
  ).toBe('wait');
  expect(
    withExecutorAdmission('codex', 'execution-b', (owner) =>
      acquireExecutorSlot('codex', 1, owner),
    ),
  ).toBeUndefined();
  slot.release();
  expect(readExecutorSlots('codex').count).toBe(0);
});
it('deduplicates a runtime session observed by an office, and waits at the total cap', () => {
  const slot = withExecutorAdmission('codex', 'execution-a', (owner) =>
    acquireExecutorSlot('codex', 2, owner),
  )!;
  slot.setSession('runtime-session');
  const store = new AgentStateStore();
  store.set(1, { id: 1, providerId: 'codex', sessionId: 'runtime-session' } as AgentState);
  const now = 1000;
  const capacity = {
    provider: 'codex' as const,
    status: 'allowed' as const,
    source: 'codex_session_log' as const,
    confidence: 'high' as const,
    observedAt: now,
    windows: [{ kind: 'five_hour' as const, usedRatio: 0.2, resetsAt: 2000 }],
  };
  const p = new MachineCapacityPublisher(
    store,
    () => ({ codex: capacity }),
    () => now * 1000,
    undefined,
    ['test'],
    () => true,
  );
  p.publish();
  const s = readSelectionSnapshot(operator, now);
  expect(s.active.codex).toBe(1);
  expect(quotaGate('codex', s.machinePolicy, s.capacities.codex, s.active.codex!, now).status).toBe(
    'go',
  );
  const second = withExecutorAdmission('codex', 'execution-b', (owner) =>
    acquireExecutorSlot('codex', 2, owner),
  )!;
  const full = readSelectionSnapshot(operator, now);
  expect(
    quotaGate('codex', full.machinePolicy, full.capacities.codex, full.active.codex!, now).status,
  ).toBe('wait');
  second.release();
  slot.release();
});
it('recovers slots/admission from a reused PID only when creation identity differs', () => {
  const dir = executorSlotsDirectory('codex');
  fs.mkdirSync(dir, { recursive: true });
  const old = {
    pid: process.pid,
    startIdentity: 'previous-process-lifetime',
    executionId: 'old',
    token: 'old',
  };
  fs.writeFileSync(path.join(dir, '0.lock'), JSON.stringify(old));
  fs.writeFileSync(path.join(dir, 'admission.lock'), JSON.stringify(old));
  const slot = withExecutorAdmission('codex', 'new', (owner) =>
    acquireExecutorSlot('codex', 1, owner),
  )!;
  expect(JSON.parse(fs.readFileSync(path.join(dir, '0.lock'), 'utf8')).startIdentity).toBe(
    slotProcessIdentity(process.pid),
  );
  slot.release();
});
it('does not recover a dead worker slot while its registered executor process is alive', () => {
  const dir = executorSlotsDirectory('codex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '0.lock'),
    JSON.stringify({
      pid: process.pid,
      startIdentity: 'previous-process-lifetime',
      token: 'old',
      executionId: 'old',
      child: { pid: process.pid, startIdentity: slotProcessIdentity(process.pid) },
    }),
  );
  expect(
    withExecutorAdmission('codex', 'new', (owner) => acquireExecutorSlot('codex', 1, owner)),
  ).toBeUndefined();
  const s = readSelectionSnapshot(operator, 1000);
  expect(quotaGate('codex', s.machinePolicy, undefined, s.active.codex!, 1000).status).toBe('wait');
});
it('fails closed if the worker dies between spawn and registering the executor PID', () => {
  const dir = executorSlotsDirectory('codex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '0.lock'),
    JSON.stringify({
      pid: process.pid,
      startIdentity: 'previous-process-lifetime',
      token: 'old',
      executionId: 'old',
      launchPending: true,
    }),
  );
  expect(
    withExecutorAdmission('codex', 'new', (owner) => acquireExecutorSlot('codex', 1, owner)),
  ).toBeUndefined();
  const s = readSelectionSnapshot(operator, 1000);
  expect(quotaGate('codex', s.machinePolicy, undefined, s.active.codex!, 1000).status).toBe('wait');
});
it('recovers a slot after the real owning process exits without releasing it', async () => {
  const bundle = path.join(home, 'slots.cjs');
  buildSync({
    entryPoints: [path.resolve(__dirname, '../src/executorSlots.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'fixtures/worker-slot-process.cjs'), bundle],
    {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    },
  );
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    await new Promise<void>((resolve) => child.once('message', () => resolve()));
    const reserved = new Promise<void>((resolve) => child.once('message', () => resolve()));
    child.send({ task: 'reserve-slot' });
    await reserved;
    expect(readExecutorSlots('codex').count).toBe(1);
    child.kill();
    await exited;
    const slot = withExecutorAdmission('codex', 'new', (owner) =>
      acquireExecutorSlot('codex', 1, owner),
    )!;
    expect(slot).toBeDefined();
    slot.release();
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
  }
}, 15000);
