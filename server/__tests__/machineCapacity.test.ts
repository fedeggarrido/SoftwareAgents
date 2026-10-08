import { spawn } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { CapacitySnapshot } from '../../core/src/capacity.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { MACHINE_CAPACITY_RETENTION_S } from '../src/constants.js';
import * as slotRuntime from '../src/executorSlots.js';
import {
  buildMachineCapacityObservation,
  collectDeadMachinePublishers,
  machineCapacityDirectory,
  MachineCapacityPublisher,
  writeMachineCapacityObservation,
} from '../src/machineCapacity.js';
import { readSelectionSnapshot } from '../src/quotaCommand.js';
import { quotaGate } from '../src/quotaGate.js';
import type { AgentState } from '../src/types.js';

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => process.env.HOME ?? actual.homedir()) };
});
vi.mock('fs', async (original) => ({ ...(await original<typeof import('fs')>()) }));
const operator = {
  autonomyLevel: 'A1' as const,
  allowedExecutors: ['codex'],
  quotaThresholds: { codex: 10 },
  concurrency: { maxExecutions: 2, perExecutor: { codex: 2 } },
};
const capacity: CapacitySnapshot = {
  provider: 'codex',
  status: 'allowed',
  windows: [{ kind: 'five_hour', usedRatio: 0.4, resetsAt: 2000 }],
  source: 'codex_session_log',
  confidence: 'high',
  observedAt: 1000,
};
function agent(id: number, providerId?: string, sessionId = `session-${id}`): AgentState {
  return { id, providerId, sessionId } as AgentState;
}
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-capacity-'));
  vi.stubEnv('HOME', home);
  fs.mkdirSync(path.join(home, '.pixel-agents'));
  fs.writeFileSync(
    path.join(home, '.pixel-agents/config.json'),
    JSON.stringify({ projects: { test: operator } }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  fs.rmSync(home, { recursive: true, force: true });
});
function publisher(
  store = new AgentStateStore(),
  get = () => ({ codex: capacity }) as Partial<Record<'claude' | 'codex', CapacitySnapshot>>,
  now = () => 1000000,
  owns = () => true,
  workspaces = ['project-a'],
) {
  return new MachineCapacityPublisher(store, get, now, undefined, workspaces, owns);
}
function gate(nowS: number) {
  const s = readSelectionSnapshot(operator, nowS);
  return quotaGate(
    'codex',
    s.machinePolicy,
    s.capacities.codex,
    s.active.codex!,
    s.nowS,
    (s.active.claude ?? 0) + (s.active.codex ?? 0),
  );
}
it('declares office coverage/provenance and maps only known providers', () => {
  const store = new AgentStateStore();
  store.set(1, agent(1, 'claude'));
  store.set(2, agent(2));
  store.set(3, agent(3, 'codex'));
  store.set(4, agent(4, 'pi'));
  const observation = buildMachineCapacityObservation(
    store,
    { codex: capacity },
    1000,
    { id: 'test', pid: process.pid, bootId: 'test', sequence: 1 },
    ['project-a'],
  );
  expect(observation.sessions).toEqual({
    claude: ['session-1', 'session-2'],
    codex: ['session-3'],
  });
  expect(observation.coverage).toEqual({
    scope: 'office',
    source: 'office_store',
    workspaces: ['project-a'],
  });
  const unknown = new AgentStateStore();
  unknown.set(4, agent(4, 'pi'));
  publisher(unknown).publish();
  expect(gate(1010).status).toBe('go');
});
it('publishes separate atomic files and asserts a final go under complete policy', () => {
  const p = publisher();
  p.publish();
  expect(p.file.startsWith(home)).toBe(true);
  expect(fs.readdirSync(machineCapacityDirectory())).toEqual([path.basename(p.file)]);
  expect(gate(1010)).toMatchObject({ status: 'go', concurrencyLimit: 2 });
  if (process.platform !== 'win32') expect(fs.statSync(p.file).mode & 0o777).toBe(0o600);
});
it('aggregates publishers from different workspaces; an empty writer cannot erase active sessions', () => {
  const a = new AgentStateStore();
  a.set(1, agent(1, 'codex'));
  a.set(2, agent(2, 'codex'));
  publisher(a).publish();
  publisher(
    new AgentStateStore(),
    () => ({}),
    () => 1000000,
    () => true,
    ['project-b'],
  ).publish();
  expect(readSelectionSnapshot(operator, 1010).coverage?.offices).toHaveLength(2);
  expect(gate(1010).status).toBe('go');
  expect(readSelectionSnapshot(operator, 1010).coverage?.counts.codex.observedSessions).toBe(2);
});
it('deduplicates the same session across offices', () => {
  const a = new AgentStateStore();
  a.set(1, agent(1, 'codex', 'shared'));
  const b = new AgentStateStore();
  b.set(9, agent(9, 'codex', 'shared'));
  publisher(a).publish();
  publisher(b).publish();
  expect(readSelectionSnapshot(operator, 1010).active.codex).toBe(0);
  expect(readSelectionSnapshot(operator, 1010).coverage?.counts.codex.observedSessions).toBe(1);
  expect(gate(1010).status).toBe('go');
});
it('partial or absent offices do not claim an interactive machine total; runtime probes remain possible', () => {
  const s = readSelectionSnapshot(operator, 1000);
  expect(s.coverage).toMatchObject({ offices: [], unobservedInteractiveSessions: 'not_counted' });
  expect(gate(1000).status).toBe('probe');
});
it('expires sessions irreversibly across wall-clock rollback, while old quota becomes a probe', () => {
  const store = new AgentStateStore();
  store.set(1, agent(1, 'codex'));
  store.set(2, agent(2, 'codex'));
  publisher(store).publish();
  expect(gate(1030).status).toBe('go');
  expect(readSelectionSnapshot(operator, 1030).coverage?.counts.codex.observedSessions).toBe(2);
  expect(gate(1061).status).toBe('probe');
  expect(gate(1050).status).toBe('probe');
  expect(readSelectionSnapshot(operator, 1050).active.codex).toBe(0);
  expect(fs.readdirSync(machineCapacityDirectory()).some((f) => f.endsWith('.invalid'))).toBe(true);
});
it('rejects a later sequence with a timestamp older than the last accepted publication', () => {
  const store = new AgentStateStore();
  store.set(1, agent(1, 'codex'));
  store.set(2, agent(2, 'codex'));
  const p = publisher(store, () => ({}));
  p.publish();
  expect(gate(1000).status).toBe('probe');
  const o = JSON.parse(fs.readFileSync(p.file, 'utf8'));
  o.publisher.sequence++;
  o.observedAt = 990;
  writeMachineCapacityObservation(o, p.file);
  expect(gate(1000).status).toBe('probe');
});
it('a new reader process cannot revive expired or backward publications from the same boot', async () => {
  const store = new AgentStateStore();
  store.set(1, agent(1, 'codex'));
  store.set(2, agent(2, 'codex'));
  const p = publisher(store, () => ({}));
  p.publish();
  expect(gate(1000).status).toBe('probe');
  expect(readSelectionSnapshot(operator, 1000).coverage?.counts.codex.observedSessions).toBe(2);
  expect(gate(1061).status).toBe('probe');
  const bundle = path.join(home, 'reader.cjs');
  buildSync({
    entryPoints: [path.resolve(__dirname, '../src/quotaCommand.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  async function readInNewProcess() {
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
      const result = new Promise<ReturnType<typeof readSelectionSnapshot>>((resolve) =>
        child.once('message', (message: { snapshot: ReturnType<typeof readSelectionSnapshot> }) =>
          resolve(message.snapshot),
        ),
      );
      child.send({ task: 'read-capacity', operator, nowS: 1050 });
      const snapshot = await result;
      await exited;
      return quotaGate(
        'codex',
        snapshot.machinePolicy,
        snapshot.capacities.codex,
        snapshot.active.codex!,
        snapshot.nowS,
        (snapshot.active.claude ?? 0) + (snapshot.active.codex ?? 0),
      ).status;
    } finally {
      if (child.exitCode === null) child.kill();
      await exited;
    }
  }
  expect(await readInNewProcess()).toBe('probe');
  const o = JSON.parse(fs.readFileSync(p.file, 'utf8'));
  o.publisher.sequence++;
  o.observedAt = 990;
  writeMachineCapacityObservation(o, p.file);
  expect(await readInNewProcess()).toBe('probe');
}, 15000);
it('publisher starts a new epoch after backward time and keeps publishing', () => {
  let now = 1000000;
  const p = publisher(
    new AgentStateStore(),
    () => ({}),
    () => now,
  );
  p.publish();
  const read = () => JSON.parse(fs.readFileSync(p.file, 'utf8'));
  now = 999000;
  p.publish();
  expect(read().observedAt).toBe(999);
  expect(read().publisher.sequence).toBe(1);
  expect(gate(1061).status).toBe('probe');
  now = 1062000;
  p.publish();
  expect(gate(1062).status).toBe('probe');
  const restarted = publisher(
    new AgentStateStore(),
    () => ({ codex: { ...capacity, observedAt: 1062 } }),
    () => now,
  );
  restarted.publish();
  expect(readSelectionSnapshot(operator, 1062).coverage?.offices).toHaveLength(2);
  expect(gate(1062).status).toBe('go');
});
it('a stalled heartbeat expires on monotonic time even when wall time is frozen', () => {
  let monotonic = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  const store = new AgentStateStore();
  store.set(1, agent(1, 'codex'));
  store.set(2, agent(2, 'codex'));
  publisher(store).publish();
  expect(gate(1000).status).toBe('go');
  monotonic += 60001;
  expect(gate(1000).status).toBe('probe');
  expect(readSelectionSnapshot(operator, 1000).active.codex).toBe(0);
});
it('refuses a non-private POSIX temporary mode and removes the temporary', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const stat = fs.fstatSync;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.spyOn(fs, 'fstatSync').mockImplementation(
      (fd) => ({ ...stat(fd), mode: 0o644 }) as fs.Stats,
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = publisher();
    p.publish();
    expect(warn).toHaveBeenCalled();
    expect(
      fs.readdirSync(machineCapacityDirectory()).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
    expect(fs.existsSync(p.file)).toBe(false);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});
it.each(['five_hour', 'weekly'] as const)(
  'retains an old rejected %s window beyond heartbeat expiry',
  (kind) => {
    publisher(new AgentStateStore(), () => ({
      codex: {
        ...capacity,
        status: 'rejected',
        observedAt: 939,
        windows: [{ kind, usedRatio: 1, resetsAt: 2000 }],
      },
    })).publish();
    expect(gate(1000)).toMatchObject({ status: 'wait', resetsAt: 2000 });
    expect(gate(1061).status).toBe('wait');
    expect(gate(2000).status).toBe('probe');
  },
);
it('new unknown/low evidence cannot erase restrictions; later reliable evidence can', () => {
  let current: CapacitySnapshot = {
    ...capacity,
    status: 'rejected',
    observedAt: 939,
    windows: [{ kind: 'five_hour', usedRatio: 1, resetsAt: 2000 }],
  };
  let now = 1000000;
  const p = publisher(
    new AgentStateStore(),
    () => ({ codex: current }),
    () => now,
  );
  p.publish();
  current = { ...capacity, observedAt: 1001, confidence: 'low' };
  now = 1001000;
  p.publish();
  expect(gate(1001).status).toBe('wait');
  current = {
    ...capacity,
    observedAt: 1002,
    status: 'unknown',
    windows: [],
    confidence: 'unknown',
  };
  now = 1002000;
  p.publish();
  expect(gate(1002).status).toBe('wait');
  current = { ...capacity, observedAt: 1003 };
  now = 1003000;
  p.publish();
  expect(gate(1003).status).toBe('go');
});
it('preserves independent window timestamps across repeated publications and multiple offices', () => {
  let current: CapacitySnapshot = {
    ...capacity,
    windows: [{ kind: 'weekly', usedRatio: 1, resetsAt: 3000 }],
  };
  let now = 1000000;
  const p = publisher(
    new AgentStateStore(),
    () => ({ codex: current }),
    () => now,
  );
  p.publish();
  current = { ...capacity, observedAt: 1100 };
  now = 1100000;
  p.publish();
  publisher(
    new AgentStateStore(),
    () => ({
      codex: {
        ...capacity,
        observedAt: 1050,
        windows: [{ kind: 'weekly', usedRatio: 0.1, resetsAt: 3000 }],
      },
    }),
    () => 1100000,
  ).publish();
  expect(gate(1100).status).toBe('go'); // reliable later weekly replaces its old restriction
  const snapshot = readSelectionSnapshot(operator, 1120).capacities.codex!;
  expect(snapshot.observedAt).toBe(1050);
  expect(gate(1120).status).toBe('probe');
});
it('does not publish when reusing a server or after losing ownership', () => {
  let owns = false;
  const p = publisher(
    new AgentStateStore(),
    () => ({}),
    () => 1000000,
    () => owns,
  );
  p.start();
  p.publish();
  expect(fs.existsSync(p.file)).toBe(false);
  owns = true;
  p.publish();
  const original = fs.readFileSync(p.file, 'utf8');
  owns = false;
  p.publish();
  expect(fs.readFileSync(p.file, 'utf8')).toBe(original);
  expect(gate(1061).status).toBe('probe');
  p.dispose();
});
it('starts once and stops the interval on dispose', () => {
  vi.useFakeTimers();
  let now = 1000000;
  const p = publisher(
    new AgentStateStore(),
    () => ({}),
    () => now,
  );
  p.start();
  p.start();
  now = 1015000;
  vi.advanceTimersByTime(15000);
  expect(JSON.parse(fs.readFileSync(p.file, 'utf8')).publisher.sequence).toBe(2);
  p.dispose();
  now = 1030000;
  vi.advanceTimersByTime(15000);
  expect(JSON.parse(fs.readFileSync(p.file, 'utf8')).observedAt).toBe(1015);
});
it.each(['writeFileSync', 'renameSync'] as const)(
  'cleans exclusive temporary files on %s failure',
  (method) => {
    const p = publisher();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(fs, method).mockImplementationOnce(() => {
      throw new Error('synthetic failure');
    });
    p.publish();
    expect(warn).toHaveBeenCalled();
    expect(fs.readdirSync(machineCapacityDirectory()).filter((f) => f.endsWith('.tmp'))).toEqual(
      [],
    );
    expect(fs.existsSync(p.file)).toBe(false);
  },
);
it.each(['EPERM', 'EBUSY', 'EBADF', 'ENOENT'])(
  'retries transient %s on per-boot publication without losing the previous observation',
  (code) => {
    const p = publisher();
    p.publish();
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync')
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('race'), { code });
      })
      .mockImplementation(rename);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    p.publish();
    expect(warn).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(p.file, 'utf8')).publisher.sequence).toBe(2);
    expect(gate(1000).status).toBe('go');
  },
);
it('an empty or truncated per-boot contribution yields a probe and a complete replacement restores capacity', () => {
  const p = publisher();
  p.publish();
  for (const partial of ['', '{"publisher":']) {
    fs.writeFileSync(p.file, partial);
    expect(gate(1000).status).toBe('probe');
  }
  p.publish();
  expect(gate(1000).status).toBe('go');
});

function gcPublication(
  name: string,
  pid = 2147483647,
  age = MACHINE_CAPACITY_RETENTION_S + 1,
  identity?: string,
) {
  const file = path.join(machineCapacityDirectory(), name + '.json');
  const observation = buildMachineCapacityObservation(
    new AgentStateStore(),
    {},
    1000000 - age,
    { id: name, pid, bootId: name, sequence: 1, startIdentity: identity },
    ['isolated'],
  );
  writeMachineCapacityObservation(observation, file);
  const invalid = file + '.invalid';
  fs.mkdirSync(path.join(invalid, name), { recursive: true });
  fs.writeFileSync(path.join(invalid, name, '1'), '');
  return { file, invalid, boot: path.join(invalid, name) };
}
it('publisher startup collects only dead and expired publications and their own tombstones', () => {
  const dead = gcPublication('dead');
  const recent = gcPublication('recent', 2147483647, 1);
  const boundary = gcPublication('boundary', 2147483647, MACHINE_CAPACITY_RETENTION_S);
  const live = gcPublication('live', process.pid);
  const malformed = gcPublication('malformed');
  fs.writeFileSync(malformed.file, '{broken');
  const future = gcPublication('future', 2147483647, -1);
  const own = publisher(
    new AgentStateStore(),
    () => ({}),
    () => 1000000000,
  );
  try {
    own.start();
  } finally {
    own.dispose();
  }
  expect(fs.existsSync(dead.file)).toBe(false);
  expect(fs.existsSync(dead.invalid)).toBe(false);
  for (const kept of [recent, boundary, live, malformed, future]) {
    expect(fs.existsSync(kept.file)).toBe(true);
    expect(fs.existsSync(kept.boot)).toBe(true);
  }
});
it('GC preserves unverifiable and EPERM publishers and reclaims reused PID identities', () => {
  const unknown = gcPublication(
    'unknown',
    process.pid,
    MACHINE_CAPACITY_RETENTION_S + 1,
    'unverified',
  );
  const denied = gcPublication(
    'denied',
    process.pid + 1,
    MACHINE_CAPACITY_RETENTION_S + 1,
    'old-identity',
  );
  const reused = gcPublication(
    'reused',
    process.pid,
    MACHINE_CAPACITY_RETENTION_S + 1,
    'old-identity',
  );
  const kill = process.kill;
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal: NodeJS.Signals | number) => {
    if (pid === process.pid + 1) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return kill(pid, signal);
  }) as typeof process.kill);
  collectDeadMachinePublishers(1000000);
  expect(fs.existsSync(unknown.file)).toBe(true);
  expect(fs.existsSync(denied.file)).toBe(true);
  expect(fs.existsSync(reused.file)).toBe(false);
  const doubtful = gcPublication('doubtful', process.pid, MACHINE_CAPACITY_RETENTION_S + 1, 'old');
  vi.spyOn(slotRuntime, 'stopped').mockReturnValue(false);
  collectDeadMachinePublishers(1000000);
  expect(fs.existsSync(doubtful.file)).toBe(true);
});
it('GC retries file contention and concurrent collectors tolerate missing generations', () => {
  const dead = gcPublication('contention');
  const unlink = fs.unlinkSync;
  let tries = 0;
  vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
    if (String(file) === dead.file && tries++ < 2)
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return unlink(file);
  });
  collectDeadMachinePublishers(1000000);
  collectDeadMachinePublishers(1000000);
  expect(tries).toBe(3);
  expect(fs.existsSync(dead.file)).toBe(false);
});
it('GC removes tombstone junctions as links and never follows linked publication roots or files', () => {
  const target = path.join(home, 'untouched');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep'), 'keep');
  const dead = gcPublication('links');
  fs.symlinkSync(
    target,
    path.join(dead.boot, 'junction'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const linkedBoot = gcPublication('linked-boot');
  fs.unlinkSync(path.join(linkedBoot.boot, '1'));
  fs.rmdirSync(linkedBoot.boot);
  fs.symlinkSync(target, linkedBoot.boot, process.platform === 'win32' ? 'junction' : 'dir');
  const linkedInvalid = gcPublication('linked-invalid');
  fs.unlinkSync(path.join(linkedInvalid.boot, '1'));
  fs.rmdirSync(linkedInvalid.boot);
  fs.rmdirSync(linkedInvalid.invalid);
  fs.symlinkSync(target, linkedInvalid.invalid, process.platform === 'win32' ? 'junction' : 'dir');
  const linkedFile = path.join(machineCapacityDirectory(), 'linked-file.json');
  // A directory junction also counts as a linked publication entry on Windows.
  fs.symlinkSync(target, linkedFile, process.platform === 'win32' ? 'junction' : 'dir');
  collectDeadMachinePublishers(1000000);
  expect(fs.readFileSync(path.join(target, 'keep'), 'utf8')).toBe('keep');
  for (const item of [dead, linkedBoot, linkedInvalid]) {
    expect(fs.existsSync(item.file)).toBe(false);
    expect(fs.existsSync(item.invalid)).toBe(false);
  }
  expect(fs.lstatSync(linkedFile).isSymbolicLink()).toBe(true);
  fs.unlinkSync(linkedFile);
  fs.rmdirSync(machineCapacityDirectory());
  fs.symlinkSync(
    target,
    machineCapacityDirectory(),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  collectDeadMachinePublishers(1000000);
  expect(fs.readFileSync(path.join(target, 'keep'), 'utf8')).toBe('keep');
  fs.unlinkSync(machineCapacityDirectory());
});
