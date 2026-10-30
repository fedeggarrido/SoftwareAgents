import type { ChildProcess } from 'child_process';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { processCancellation } from '../src/executors/processCancellation.js';
import { spawnRegisteredProcess } from '../src/executors/registeredProcess.js';

vi.mock('child_process', async (original) => {
  const actual = await original<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registered-process-'));
});
afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** Resolves with the events seen once 'close' arrives; rejects if it never does. */
function settle(child: ChildProcess, timeoutMs = 8000) {
  const seen: string[] = [];
  child.stdout!.resume();
  child.stderr!.resume();
  child.on('error', () => seen.push('error'));
  child.on('exit', () => seen.push('exit'));
  return new Promise<{ seen: string[]; code: number | null }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no 'close' within ${timeoutMs} ms (saw: ${seen.join(', ')})`)),
      timeoutMs,
    );
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ seen, code });
    });
  });
}

const marker = () => path.join(dir, 'launched');
const command = () => ['-e', `require('fs').writeFileSync(${JSON.stringify(marker())}, 'x')`];

it('a failed registration still closes, so executors release their slot and lock', async () => {
  const child = spawnRegisteredProcess(process.execPath, command(), dir, () => {
    throw new Error('Cannot verify launch process');
  });
  const { seen } = await settle(child);
  expect(seen).toContain('error');
  expect(seen).toContain('exit');
  // Nothing was ACKed, so the CLI never ran.
  expect(fs.existsSync(marker())).toBe(false);
});

it('an asynchronous registration rejection leaves no supervisor or CLI alive', async () => {
  const failure = new Error('durable registration failed');
  let observed: Error | undefined;
  const child = spawnRegisteredProcess(process.execPath, command(), dir, async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    throw failure;
  });
  child.on('error', (error) => {
    observed = error;
  });
  await settle(child);
  expect(observed).toBe(failure);
  expect(() => process.kill(child.pid!, 0)).toThrow();
  expect(fs.existsSync(marker())).toBe(false);
});

it('a registered process launches the CLI and closes with its exit code', async () => {
  let registered: number | undefined;
  const child = spawnRegisteredProcess(process.execPath, command(), dir, (pid) => {
    registered = pid;
  });
  const { seen, code } = await settle(child);
  expect(registered).toBe(child.pid);
  expect(seen).not.toContain('error');
  expect(code).toBe(0);
  expect(fs.existsSync(marker())).toBe(true);
  expect(childProcess.spawn).toHaveBeenCalledWith(
    process.execPath,
    expect.any(Array),
    expect.objectContaining({ detached: true, windowsHide: true }),
  );
});

it('reports a CLI spawn failure without copying its path or arguments', async () => {
  const child = spawnRegisteredProcess(
    path.join(dir, 'SECRET-missing.exe'),
    ['SECRET-prompt'],
    dir,
    () => {},
  );
  let diagnostic = '';
  child.on('error', (error) => {
    diagnostic = error.message;
  });
  expect((await settle(child)).code).not.toBe(0);
  expect(diagnostic).toBe('Executor spawn failed');
});

it('retains the verifiable root until durable closure is acknowledged', async () => {
  let persist!: () => void;
  let closing = false;
  const child = spawnRegisteredProcess(
    process.execPath,
    command(),
    dir,
    () => {},
    () => {
      closing = true;
      return new Promise<void>((resolve) => {
        persist = resolve;
      });
    },
  );
  const completion = settle(child);
  try {
    await vi.waitFor(() => expect(closing).toBe(true), { timeout: 5000 });
    expect(child.exitCode).toBeNull();
    expect(process.kill(child.pid!, 0)).toBe(true);
    persist();
    expect((await completion).code).toBe(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await completion;
  }
});

it('retains the root after CLI close when the worker disconnects before persisting', async () => {
  let closing = false;
  const child = spawnRegisteredProcess(
    process.execPath,
    command(),
    dir,
    () => {},
    () => {
      closing = true;
      return new Promise<void>(() => {});
    },
  );
  child.stdout!.resume();
  child.stderr!.resume();
  // Node may omit close when the parent disconnects IPC itself. This simulates
  // worker death, so assert/clean up using exit and the retained fixture PID.
  const completion = new Promise((resolve) => child.once('exit', resolve));
  try {
    await vi.waitFor(() => expect(closing).toBe(true), { timeout: 5000 });
    child.disconnect();
    // Wait beyond a complete event-loop turn: loss of IPC must not release root.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(child.exitCode).toBeNull();
    expect(process.kill(child.pid!, 0)).toBe(true);
  } finally {
    // CLI is already closed; the only remaining process is this fixture root.
    child.kill();
    await completion;
  }
});

it.skipIf(process.platform !== 'win32' || process.env.SA_SKIP_TASKKILL_TEST === '1')(
  'a live worker can cancel a detached registered tree without leaving descendants',
  async () => {
    const pids = path.join(dir, 'pids.json');
    const script = `const {spawn}=require('child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}); require('fs').writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000)`;
    const child = spawnRegisteredProcess(process.execPath, ['-e', script], dir, () => {});
    const completion = settle(child);
    const cancellation = processCancellation(() => child);
    try {
      await vi.waitFor(() => expect(fs.existsSync(pids)).toBe(true), { timeout: 5000 });
      cancellation.cancel();
      await completion;
      cancellation.confirmClose();
      for (const pid of JSON.parse(fs.readFileSync(pids, 'utf8')) as number[])
        await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    } finally {
      if (child.exitCode === null && child.signalCode === null) cancellation.cancel();
      await completion;
      cancellation.confirmClose();
    }
  },
);
