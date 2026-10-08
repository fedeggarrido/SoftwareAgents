import * as childProcess from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import {
  CODEX_SUBAGENT_FINAL_TIMEOUT_MS,
  EXECUTOR_TASKKILL_TIMEOUT_MS,
  EXECUTOR_TERMINATION_RETRY_MS,
  EXECUTOR_TERMINATION_TIMEOUT_MS,
} from '../src/constants.js';
import { ClaudeCliExecutor } from '../src/executors/claudeCliExecutor.js';
import { CodexCliExecutor } from '../src/executors/codexCliExecutor.js';
import type { ExecutionEvent, ExecutionRequest } from '../src/executors/executor.js';

vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));
vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: () => process.env.HOME ?? actual.homedir() };
});

vi.mock('fs', async (original) => ({ ...(await original<typeof import('fs')>()) }));

let root: string;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
let proc: EventEmitter & {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-termination-'));
  fs.mkdirSync(path.join(root, 'worktree'));
  vi.stubEnv('HOME', root);
  vi.useFakeTimers();
  proc = Object.assign(new EventEmitter(), {
    pid: 123,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  });
  vi.mocked(childProcess.spawn).mockReturnValue(proc as unknown as childProcess.ChildProcess);
});

function start(id: string, timeoutMin = 1) {
  const options = { runtimeDirectory: path.join(root, 'runtime') };
  const executor =
    id === 'claude'
      ? new ClaudeCliExecutor({ ...options, binary: process.execPath })
      : new CodexCliExecutor({
          ...options,
          operator: { binaryPaths: { codex: process.execPath } },
          sessionsDirectory: path.join(root, 'sessions'),
        });
  return executor.start({
    executionId: 'run',
    projectId: 'project',
    taskKey: 'SA-999',
    role: 'reviewer',
    prompt: 'test',
    flags: [],
    worktreePath: path.join(root, 'worktree'),
    timeoutMin,
    agentSpec: parse(
      fs.readFileSync(path.join(__dirname, '../../agents/templates/reviewer.yaml'), 'utf8'),
    ),
  });
}
function ownRollout() {
  const d = new Date();
  const folder = path.join(
    root,
    'sessions',
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  );
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'rollout-parent.jsonl');
  fs.writeFileSync(file, '{"type":"session_meta","payload":{"id":"parent"}}\n');
  return file;
}

it.each(['claude', 'codex'].flatMap((id) => [false, true].map((signal) => [id, signal] as const)))(
  '%s never kills a released PID after exit (signal=%s), and waits for stdio close',
  async (id, signal) => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
    const handle = start(id, 0.01);
    const events: ExecutionEvent[] = [];
    const collecting = (async () => {
      for await (const event of handle.events) events.push(event);
    })();
    if (signal) proc.signalCode = 'SIGKILL';
    else proc.exitCode = 0;
    proc.emit('exit', proc.exitCode, proc.signalCode);
    handle.cancel();
    await vi.advanceTimersByTimeAsync(1000); // timeout before inherited pipes finish draining
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'finished')).toBe(false);
    if (id === 'codex') ownRollout();
    proc.stdout.end(
      id === 'codex'
        ? '{"type":"thread.started","thread_id":"parent"}\n{"type":"turn.completed"}\n'
        : '{"type":"result","result":"ok"}\n',
    );
    proc.stderr.end();
    proc.emit('close', proc.exitCode, proc.signalCode);
    await collecting;
    expect(events.at(-1)).toEqual({ type: 'finished', exitCode: 130, resultSummary: 'Cancelled' });
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  },
);

it.each(['claude', 'codex'])(
  '%s reports Cancelled after a transient kill failure recovers',
  async (id) => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
    const kill = vi.mocked(childProcess.execFileSync);
    kill
      .mockImplementationOnce(() => {
        throw new Error('transient');
      })
      .mockReturnValue(Buffer.alloc(0));
    const handle = start(id);
    const events: ExecutionEvent[] = [];
    const collecting = (async () => {
      for await (const event of handle.events) events.push(event);
    })();
    expect(() => handle.cancel()).toThrow('transient');
    await vi.advanceTimersByTimeAsync(EXECUTOR_TERMINATION_RETRY_MS);
    expect(kill).toHaveBeenCalledTimes(2);
    proc.stdout.end();
    proc.stderr.end();
    proc.emit('close', 0);
    await collecting;
    expect(events.at(-1)).toEqual({ type: 'finished', exitCode: 130, resultSummary: 'Cancelled' });
  },
);

it('never schedules a taskkill without its full fixed timeout budget', async () => {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  const kill = vi.mocked(childProcess.execFileSync).mockImplementation(() => {
    vi.setSystemTime(Date.now() + EXECUTOR_TASKKILL_TIMEOUT_MS);
    throw new Error('slow failure');
  });
  const handle = start('claude');
  const collecting = (async () => {
    for await (const _event of handle.events) {
      /* drain */
    }
  })();
  expect(() => handle.cancel()).toThrow('slow failure');
  await vi.advanceTimersByTimeAsync(EXECUTOR_TERMINATION_RETRY_MS);
  expect(kill).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(EXECUTOR_TERMINATION_TIMEOUT_MS);
  expect(kill).toHaveBeenCalledTimes(2);
  for (const call of kill.mock.calls)
    expect(call[2]).toMatchObject({ timeout: EXECUTOR_TASKKILL_TIMEOUT_MS });
  proc.stdout.end();
  proc.stderr.end();
  proc.emit('close', 0);
  await collecting;
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it.each(
  ['win32', 'linux'].flatMap((platform) =>
    ['claude', 'codex'].map((id) => [platform, id] as const),
  ),
)(
  '%s/%s retries failed termination, keeps the policy reason, and waits for close',
  async (platform, id) => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
    const kill =
      process.platform === 'win32'
        ? vi.mocked(childProcess.execFileSync)
        : vi.spyOn(process, 'kill');
    kill.mockImplementation(() => {
      throw new Error('termination failed');
    });
    const spec = parse(
      fs.readFileSync(path.join(__dirname, '../../agents/templates/reviewer.yaml'), 'utf8'),
    );
    const req: ExecutionRequest = {
      executionId: 'run',
      projectId: 'project',
      taskKey: 'SA-999',
      role: 'reviewer',
      agentSpec: spec,
      prompt: 'test',
      flags: [],
      worktreePath: path.join(root, 'worktree'),
      timeoutMin: 0.2,
    };
    const options = { runtimeDirectory: path.join(root, 'runtime') };
    const executor =
      id === 'claude'
        ? new ClaudeCliExecutor({ ...options, binary: process.execPath })
        : new CodexCliExecutor({
            ...options,
            operator: { binaryPaths: { codex: process.execPath } },
            sessionsDirectory: path.join(root, 'sessions'),
          });
    const handle = executor.start(req);
    const events: ExecutionEvent[] = [];
    const collecting = (async () => {
      for await (const event of handle.events) events.push(event);
    })();
    proc.stdout.write(
      JSON.stringify(
        id === 'claude'
          ? {
              type: 'assistant',
              message: {
                content: [
                  { type: 'tool_use', id: 'bad', name: 'Agent', input: { prompt: 'TEST_SECRET' } },
                ],
              },
            }
          : {
              type: 'item.started',
              item: {
                id: 'bad',
                type: 'collab_tool_call',
                tool: 'spawn_agent',
                arguments: { prompt: 'TEST_SECRET' },
              },
            },
      ) + '\n',
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(EXECUTOR_TERMINATION_RETRY_MS);
    expect(kill).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(EXECUTOR_TERMINATION_TIMEOUT_MS);
    const stopped = kill.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(kill).toHaveBeenCalledTimes(stopped); // bounded automatic retry window
    expect(() => handle.cancel()).toThrow('termination failed');
    expect(kill.mock.calls.length).toBe(stopped + 1);
    await vi.advanceTimersByTimeAsync(12_000); // timeout also starts a new retry window
    expect(kill.mock.calls.length).toBeGreaterThan(stopped + 2);
    expect(events.some((event) => event.type === 'finished')).toBe(false);
    kill.mockImplementation(() => true as never);
    handle.cancel(); // recovery still waits for a confirmed process close
    expect(events.some((event) => event.type === 'finished')).toBe(false);
    proc.stdout.end();
    proc.stderr.end();
    proc.emit('close', 0);
    await collecting;
    expect(events.at(-1)).toMatchObject({
      type: 'finished',
      exitCode: 1,
      resultSummary: expect.stringMatching(/^Policy violation: /),
    });
    expect(JSON.stringify(events)).not.toContain('termination failed');
    expect(JSON.stringify(events)).not.toContain('TEST_SECRET');
    const finalCalls = kill.mock.calls.length;
    handle.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kill).toHaveBeenCalledTimes(finalCalls);
  },
);

it.each([false, true])(
  'Codex retries an inconclusive watcher; final uncertainty=%s',
  async (uncertain) => {
    const read = vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    });
    const spec = parse(
      fs.readFileSync(path.join(__dirname, '../../agents/templates/reviewer.yaml'), 'utf8'),
    );
    const handle = new CodexCliExecutor({
      runtimeDirectory: path.join(root, 'runtime'),
      operator: { binaryPaths: { codex: process.execPath } },
      sessionsDirectory: path.join(root, 'sessions'),
    }).start({
      executionId: 'run',
      projectId: 'project',
      taskKey: 'SA-999',
      role: 'reviewer',
      agentSpec: spec,
      prompt: 'test',
      flags: [],
      worktreePath: path.join(root, 'worktree'),
      timeoutMin: 1,
    });
    const events: ExecutionEvent[] = [];
    const collecting = (async () => {
      for await (const event of handle.events) events.push(event);
    })();
    proc.stdout.write('{"type":"thread.started","thread_id":"parent"}\n');
    await vi.advanceTimersByTimeAsync(2000);
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(events.some((event) => event.type === 'finished')).toBe(false);
    if (!uncertain) {
      read.mockRestore();
      ownRollout();
    }
    proc.stdout.end('{"type":"turn.completed"}\n');
    proc.stderr.end();
    proc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(CODEX_SUBAGENT_FINAL_TIMEOUT_MS);
    await collecting;
    expect(events.at(-1)).toMatchObject({ type: 'finished', exitCode: uncertain ? 1 : 0 });
    if (uncertain)
      expect(events.at(-1)).toMatchObject({
        resultSummary: expect.stringContaining('could not verify that no sub-agent was spawned'),
      });
    read.mockRestore();
  },
);

it.each(['absent', 'wrong-root', 'other', 'child', 'malformed'])(
  'Codex bounds final uncertainty and retries headers after close (%s)',
  async (scenario) => {
    const handle = start('codex', 0.001); // final verification must outlive the execution timer
    const events: ExecutionEvent[] = [];
    const collecting = (async () => {
      for await (const event of handle.events) events.push(event);
    })();
    let candidate: string | undefined;
    if (scenario !== 'absent') {
      const own = ownRollout();
      if (scenario === 'wrong-root') fs.renameSync(own, own.replace('parent.jsonl', 'other.jsonl'));
      else {
        candidate = path.join(path.dirname(own), 'rollout-new-session.jsonl');
        fs.writeFileSync(
          candidate,
          scenario === 'malformed' ? 'invalid JSON\n' : '{"type":"session_meta"',
        );
      }
    }
    proc.exitCode = 0;
    proc.emit('exit', 0);
    proc.stdout.end('{"type":"thread.started","thread_id":"parent"}\n{"type":"turn.completed"}\n');
    proc.stderr.end();
    proc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(100);
    expect(events.some((event) => event.type === 'finished')).toBe(false);
    if (scenario === 'other' || scenario === 'child') {
      fs.writeFileSync(
        candidate!,
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: 'new-session',
            ...(scenario === 'child' ? { parent_thread_id: 'parent' } : {}),
          },
        }) + '\n',
      );
    }
    await vi.advanceTimersByTimeAsync(CODEX_SUBAGENT_FINAL_TIMEOUT_MS);
    await collecting;
    expect(events.at(-1)).toMatchObject({
      type: 'finished',
      exitCode: scenario === 'other' ? 0 : 1,
    });
    if (scenario === 'other') expect(events.at(-1)).toMatchObject({ resultSummary: '' });
    else
      expect(events.at(-1)).toMatchObject({
        resultSummary: expect.stringContaining(
          scenario === 'child'
            ? 'spawned a sub-agent'
            : 'could not verify that no sub-agent was spawned',
        ),
      });
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  },
);
