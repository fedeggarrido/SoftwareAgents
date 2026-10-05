import * as childProcess from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import {
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
      resultSummary: expect.stringMatching(/Policy violation: .*; termination failed/),
    });
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
    if (!uncertain) read.mockRestore();
    proc.stdout.end('{"type":"turn.completed"}\n');
    proc.stderr.end();
    proc.emit('close', 0);
    await collecting;
    expect(events.at(-1)).toMatchObject({ type: 'finished', exitCode: uncertain ? 1 : 0 });
    if (uncertain)
      expect(events.at(-1)).toMatchObject({
        resultSummary: expect.stringContaining('could not verify that no sub-agent was spawned'),
      });
    read.mockRestore();
  },
);
