import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import {
  acquireExecutorSlot,
  executorSlotsDirectory,
  slotProcessIdentity,
  withExecutorAdmission,
} from '../src/executorSlots.js';
import { retryFileOperation } from '../src/fileContention.js';
import { MachineCapacityPublisher } from '../src/machineCapacity.js';
import { readSelectionSnapshot } from '../src/quotaCommand.js';
import { quotaGate } from '../src/quotaGate.js';
import { parseClaudeRateLimit } from '../src/quotaReader.js';
import type { AgentState } from '../src/types.js';

vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));
vi.mock('fs', async (original) => ({ ...(await original<typeof import('fs')>()) }));
vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
}));
let home: string;
const operator = {
  autonomyLevel: 'A1' as const,
  allowedExecutors: ['claude'],
  quotaThresholds: { claude: 5 },
  concurrency: { maxExecutions: 1, perExecutor: { claude: 1 } },
};
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'qa5-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  fs.mkdirSync(path.join(home, '.pixel-agents'));
  fs.writeFileSync(
    path.join(home, '.pixel-agents/config.json'),
    JSON.stringify({ projects: { test: operator } }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});
function gate(now: number) {
  const s = readSelectionSnapshot(operator, now);
  return quotaGate('claude', s.machinePolicy, s.capacities.claude, s.active.claude!, now);
}
it('P1: an interactive session does not consume the worker limit or probe', () => {
  const store = new AgentStateStore();
  store.set(1, { id: 1, sessionId: 'operator', providerId: 'claude' } as AgentState);
  new MachineCapacityPublisher(
    store,
    () => ({}),
    () => 1000000,
    undefined,
    ['test'],
    () => true,
  ).publish();
  expect(gate(1000).status).toBe('probe');
});
it('P2: retries transient slot update EPERM', () => {
  const slot = withExecutorAdmission('claude', 'test', (owner) =>
    acquireExecutorSlot('claude', 1, owner),
  )!;
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync')
    .mockImplementationOnce(() => {
      throw Object.assign(new Error('busy'), { code: 'EPERM' });
    })
    .mockImplementation(rename);
  expect(() => slot.setSession('test')).not.toThrow();
  slot.release();
});
it('P3: inaccessible PID identity is unknown, never an exception', () => {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
    throw new Error('denied');
  });
  expect(() => slotProcessIdentity(4)).not.toThrow();
});
it('P4: identity query exit race returns dead', () => {
  vi.spyOn(process, 'kill')
    .mockImplementationOnce(() => true)
    .mockImplementation(() => {
      throw Object.assign(new Error('exited'), { code: 'ESRCH' });
    });
  vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
    throw new Error('exited');
  });
  expect(slotProcessIdentity(987654)).toBeNull();
});
it('P5: clock rollback retains live rejection', () => {
  new MachineCapacityPublisher(
    new AgentStateStore(),
    () => ({
      claude: parseClaudeRateLimit(
        { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 5000 },
        1000,
        1000,
      ).capacity!,
    }),
    () => 1000000,
    undefined,
    ['test'],
    () => true,
  ).publish();
  expect(gate(1000).status).toBe('wait');
  expect(gate(990)).toMatchObject({ status: 'wait', resetsAt: 5000 });
});
it('P6: publisher keeps publishing after clock correction', () => {
  let now = 1000000;
  const p = new MachineCapacityPublisher(
    new AgentStateStore(),
    () => ({}),
    () => now,
    undefined,
    ['test'],
    () => true,
  );
  p.publish();
  now = 4600000;
  p.publish();
  now = 1030000;
  p.publish();
  expect(JSON.parse(fs.readFileSync(p.file, 'utf8')).observedAt).toBe(1030);
});
it('P6: future heartbeat retains live-publisher session telemetry and does not poison the next epoch', () => {
  let now = 1000000;
  const store = new AgentStateStore();
  store.set(1, { id: 1, sessionId: 'operator', providerId: 'claude' } as AgentState);
  const p = new MachineCapacityPublisher(
    store,
    () => ({}),
    () => now,
    undefined,
    ['test'],
    () => true,
  );
  p.publish();
  now = 4600000;
  p.publish();
  now = 1030000;
  expect(readSelectionSnapshot(operator, 1030).coverage?.counts.claude.observedSessions).toBe(1);
  const old = JSON.parse(fs.readFileSync(p.file, 'utf8')).publisher.bootId;
  p.publish();
  expect(JSON.parse(fs.readFileSync(p.file, 'utf8')).publisher.bootId).not.toBe(old);
  expect(readSelectionSnapshot(operator, 1030).coverage?.counts.claude.observedSessions).toBe(1);
});
it('P7: different Claude limit types cannot supersede each other', () => {
  let now = 1000;
  let cap = parseClaudeRateLimit(
    { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: 410000 },
    now,
    now,
  ).capacity!;
  const p = new MachineCapacityPublisher(
    new AgentStateStore(),
    () => ({ claude: cap }),
    () => now * 1000,
    undefined,
    ['test'],
    () => true,
  );
  p.publish();
  now++;
  cap = parseClaudeRateLimit(
    {
      status: 'allowed_warning',
      rateLimitType: 'seven_day_sonnet',
      utilization: 0.91,
      resetsAt: 410000,
    },
    now,
    now,
  ).capacity!;
  p.publish();
  expect(gate(now)).toMatchObject({ status: 'wait', resetsAt: 410000 });
});
it('P8: Darwin has a POSIX identity path', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.spyOn(childProcess, 'execFileSync').mockReturnValue('Thu Oct  8 12:34:56 2026\n');
    expect(slotProcessIdentity(12345)).toBe('Thu Oct  8 12:34:56 2026');
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});
it('P8: Linux combines boot identity and registered PID start ticks, including spaced process names', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const read = fs.readFileSync;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const fields = Array(20).fill('0');
    fields[19] = '9876';
    vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof read>) => {
      if (String(args[0]) === '/proc/1234567/stat')
        return `1234567 (node with spaces) ${fields.join(' ')}`;
      if (String(args[0]) === '/proc/sys/kernel/random/boot_id') return 'test-boot\n';
      return read(...args);
    });
    expect(slotProcessIdentity(1234567)).toBe('test-boot:9876');
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});
it.each(['admission.lock', 'recovery.lock', '0.lock'])('P9: old empty %s is recovered', (name) => {
  const dir = executorSlotsDirectory('claude');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, '');
  fs.utimesSync(file, new Date(0), new Date(0));
  const slot = withExecutorAdmission('claude', 'test', (owner) =>
    acquireExecutorSlot('claude', 1, owner),
  );
  expect(slot).toBeDefined();
  slot?.release();
});
it('P9: stale recovery and admission owners are recovered together', () => {
  const dir = executorSlotsDirectory('claude');
  fs.mkdirSync(dir, { recursive: true });
  const dead = { pid: 987654321, startIdentity: 'dead', executionId: 'old', token: 'old' };
  for (const name of ['admission.lock', 'recovery.lock'])
    fs.writeFileSync(path.join(dir, name), JSON.stringify(dead));
  const slot = withExecutorAdmission('claude', 'new', (owner) =>
    acquireExecutorSlot('claude', 1, owner),
  );
  expect(slot).toBeDefined();
  slot?.release();
});
it.each(['EPERM', 'EBUSY', 'EBADF', 'ENOENT'])(
  'B: retries %s during exclusive create and release',
  (code) => {
    const open = fs.openSync,
      unlink = fs.unlinkSync;
    vi.spyOn(fs, 'openSync')
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('contention'), { code });
      })
      .mockImplementation(open);
    const slot = withExecutorAdmission('claude', 'test', (owner) =>
      acquireExecutorSlot('claude', 1, owner),
    )!;
    expect(slot).toBeDefined();
    if (code !== 'ENOENT')
      vi.spyOn(fs, 'unlinkSync')
        .mockImplementationOnce(() => {
          throw Object.assign(new Error('contention'), { code });
        })
        .mockImplementation(unlink);
    expect(() => slot.release()).not.toThrow();
  },
);
it('B: fsync failure cannot leave a complete choosing record owned by the still-live caller', () => {
  vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
    throw new Error('synthetic fsync failure');
  });
  expect(() =>
    withExecutorAdmission('claude', 'failed', (owner) => acquireExecutorSlot('claude', 1, owner)),
  ).toThrow('fsync');
  expect(fs.readdirSync(executorSlotsDirectory('claude'))).toEqual([]);
  const slot = withExecutorAdmission('claude', 'retry', (owner) =>
    acquireExecutorSlot('claude', 1, owner),
  );
  expect(slot).toBeDefined();
  slot?.release();
});
it('B: an unreadable old ticket is busy, never an expired incomplete ticket', () => {
  const dir = executorSlotsDirectory('claude');
  fs.mkdirSync(dir, { recursive: true });
  const claim = path.join(dir, 'old.claim');
  fs.writeFileSync(
    claim,
    JSON.stringify({
      pid: process.pid,
      startIdentity: slotProcessIdentity(process.pid),
      token: 'old',
      executionId: 'old',
    }),
  );
  fs.writeFileSync(`${claim}.ready`, '1');
  fs.utimesSync(claim, new Date(0), new Date(0));
  const read = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof read>) => {
    if (String(args[0]) === `${claim}.ready`)
      throw Object.assign(new Error('busy'), { code: 'EPERM' });
    return read(...args);
  });
  expect(
    withExecutorAdmission('claude', 'new', (owner) => acquireExecutorSlot('claude', 1, owner)),
  ).toBeUndefined();
  expect(fs.existsSync(claim)).toBe(true);
});
it('B: young incomplete slot waits; expiry admits again', () => {
  const dir = executorSlotsDirectory('claude');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '0.lock');
  fs.writeFileSync(file, '{"pid":');
  expect(
    withExecutorAdmission('claude', 'test', (owner) => acquireExecutorSlot('claude', 1, owner)),
  ).toBeUndefined();
  fs.utimesSync(file, new Date(0), new Date(0));
  const slot = withExecutorAdmission('claude', 'test', (owner) =>
    acquireExecutorSlot('claude', 1, owner),
  );
  expect(slot).toBeDefined();
  slot?.release();
});
it('B: future-dated incomplete slot gets a persisted lease after clock rollback', () => {
  const dir = executorSlotsDirectory('claude');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '0.lock');
  fs.writeFileSync(file, '');
  fs.utimesSync(file, new Date(Date.now() + 3600000), new Date(Date.now() + 3600000));
  expect(
    withExecutorAdmission('claude', 'new', (owner) => acquireExecutorSlot('claude', 1, owner)),
  ).toBeUndefined();
  expect(fs.statSync(file).mtimeMs).toBeLessThanOrEqual(Date.now());
  expect(Date.now() - fs.statSync(file).mtimeMs).toBeLessThan(1000);
});
it.skipIf(process.platform !== 'win32')(
  'P3: real Windows system PID cannot make admission throw',
  () => {
    expect(() => slotProcessIdentity(4)).not.toThrow();
    const dir = executorSlotsDirectory('claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '0.lock'),
      JSON.stringify({ pid: 4, startIdentity: 'recycled', token: 'old', executionId: 'old' }),
    );
    expect(() =>
      withExecutorAdmission('claude', 'test', (owner) => acquireExecutorSlot('claude', 1, owner)),
    ).not.toThrow();
  },
);
it('B: an old choosing claim with half-written ticket expires without a permanent recovery guard', () => {
  const dir = executorSlotsDirectory('claude');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'old.claim');
  fs.writeFileSync(
    file,
    JSON.stringify({
      pid: process.pid,
      startIdentity: slotProcessIdentity(process.pid),
      token: 'old',
      executionId: 'old',
    }),
  );
  fs.writeFileSync(`${file}.ready`, '{');
  fs.utimesSync(file, new Date(0), new Date(0));
  const slot = withExecutorAdmission('claude', 'new', (owner) =>
    acquireExecutorSlot('claude', 1, owner),
  );
  expect(slot).toBeDefined();
  slot?.release();
  expect(fs.existsSync(file)).toBe(false);
});
it('B: access failures cannot lease out an old, complete live slot', () => {
  const slot = withExecutorAdmission('claude', 'live', (owner) =>
    acquireExecutorSlot('claude', 1, owner),
  )!;
  const file = path.join(executorSlotsDirectory('claude'), '0.lock');
  fs.utimesSync(file, new Date(0), new Date(0));
  const read = fs.readFileSync;
  const spy = vi
    .spyOn(fs, 'readFileSync')
    .mockImplementation((...args: Parameters<typeof read>) => {
      if (String(args[0]) === file)
        throw Object.assign(new Error('access denied'), { code: 'EPERM' });
      return read(...args);
    });
  expect(
    withExecutorAdmission('claude', 'new', (owner) => acquireExecutorSlot('claude', 1, owner)),
  ).toBeUndefined();
  spy.mockRestore();
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).executionId).toBe('live');
  slot.release();
});
it.each(['EPERM', 'EBUSY', 'EBADF', 'ENOENT'])(
  'B: bounded helper retries %s from realpath',
  (code) => {
    const real = fs.realpathSync;
    vi.spyOn(fs, 'realpathSync')
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('race'), { code });
      })
      .mockImplementation(real);
    expect(retryFileOperation(() => fs.realpathSync(home))).toBe(real(home));
  },
);
