import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { CodexCliExecutor } from '../src/executors/codexCliExecutor.js';
import { ExecutionRegistry } from '../src/executors/executionRegistry.js';
import type { ExecutionEvent, ExecutionRequest } from '../src/executors/executor.js';
import { FakeExecutor } from '../src/executors/fakeExecutor.js';

let root: string;
let req: ExecutionRequest;
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-'));
  git('init');
  // Per-command identity, never change Git configuration.
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'base',
  );
  req = {
    executionId: 'execution-1',
    projectId: 'project-1',
    taskKey: 'SA-031',
    role: 'developer',
    prompt: 'Implement',
    flags: [],
    worktreePath: root,
    model: 'fake-model',
    timeoutMin: 1,
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('Execution contract and transitional registry', () => {
  it.each(['claude', 'codex'] as const)(
    'records %s traceability, events and recoverable Session labels',
    async (id) => {
      const registry = new ExecutionRegistry(root);
      const handle = registry.executor(new FakeExecutor(id)).start(req);
      const events: ExecutionEvent[] = [];
      for await (const event of handle.events) {
        events.push(event);
      }
      const directory = path.join(root, '.git/softwareagents');
      const lines = fs
        .readFileSync(path.join(directory, 'executions.jsonl'), 'utf8')
        .trim()
        .split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual({
        executionId: req.executionId,
        projectId: req.projectId,
        executor: id,
        model: req.model,
        sessionId: `fake-${id}-${req.executionId}`,
        pid: 1,
        startedAt: '2026-01-01T00:00:00.000Z',
        taskKey: req.taskKey,
        role: req.role,
        promptHash: createHash('sha256').update(req.prompt).digest('hex'),
        baseSha: git('rev-parse', 'HEAD'),
      });
      expect(
        fs
          .readFileSync(path.join(directory, 'runs/execution-1.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual(events);
      expect(events.map((event) => event.type)).toEqual([
        'started',
        'toolUse',
        'usage',
        'rateLimit',
        'output',
        'finished',
      ]);
      expect(new ExecutionRegistry(root).sessionMap().get(`fake-${id}-${req.executionId}`)).toEqual(
        { executionId: req.executionId, role: req.role, taskKey: req.taskKey },
      );
      expect(() => registry.executor(new FakeExecutor(id)).start(req)).toThrow();
    },
  );

  it('records cancellation and omits an unspecified Model explicitly', async () => {
    delete req.model;
    const handle = new ExecutionRegistry(root).executor(new FakeExecutor('codex')).start(req);
    handle.cancel();
    const events = [];
    for await (const event of handle.events) {
      events.push(event);
    }
    expect(events.at(-1)).toEqual({ type: 'finished', exitCode: 130, resultSummary: 'Cancelled' });
    expect(
      JSON.parse(fs.readFileSync(path.join(root, '.git/softwareagents/executions.jsonl'), 'utf8'))
        .model,
    ).toBeNull();
  });

  it('rejects traversal before starting an Executor', () => {
    req.executionId = '../escape';
    expect(() =>
      new ExecutionRegistry(root).executor(new FakeExecutor('claude')).start(req),
    ).toThrow('Invalid executionId');
  });

  it('rejects a storage junction escaping the common Git directory', () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, '.git/softwareagents'), 'junction');
    expect(() =>
      new ExecutionRegistry(root).executor(new FakeExecutor('claude')).start(req),
    ).toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('preserves separate logs when two registries append interleaved Executions', async () => {
    const handles = ['first', 'second'].map((executionId) =>
      new ExecutionRegistry(root)
        .executor(new FakeExecutor('codex'))
        .start({ ...req, executionId }),
    );
    await Promise.all(
      handles.map(async (handle) => {
        for await (const event of handle.events) {
          expect(event.type).toBeTruthy();
        }
      }),
    );
    expect(new ExecutionRegistry(root).sessionMap().size).toBe(2);
    for (const executionId of ['first', 'second']) {
      const lines = fs
        .readFileSync(path.join(root, `.git/softwareagents/runs/${executionId}.jsonl`), 'utf8')
        .trim()
        .split('\n');
      expect(lines).toHaveLength(6);
      expect(JSON.parse(lines[0]).sessionId).toBe(`fake-codex-${executionId}`);
    }
  });

  it('fails closed on an occupied append lock and cancels the Execution', async () => {
    const handle = new ExecutionRegistry(root).executor(new FakeExecutor('claude')).start(req);
    fs.writeFileSync(path.join(root, '.git/softwareagents/executions.jsonl.lock'), 'held');
    await expect(handle.events[Symbol.asyncIterator]().next()).rejects.toThrow();
    expect(fs.existsSync(path.join(root, '.git/softwareagents/executions.jsonl'))).toBe(false);
  });

  it('uses the common Git directory for a linked worktree', async () => {
    const linked = path.join(root, 'linked');
    git('worktree', 'add', '-b', 'linked', linked);
    req.worktreePath = linked;
    const handle = new ExecutionRegistry(linked).executor(new FakeExecutor('codex')).start(req);
    for await (const event of handle.events) {
      expect(event.type).toBeTruthy();
    }
    expect(new ExecutionRegistry(root).sessionMap().size).toBe(1);
  });
});

it.each(['claude', 'codex'] as const)(
  'provides deterministic %s CLI usage and rate-limit fixtures',
  (id) => {
    const args = id === 'claude' ? ['-p', '--output-format', 'stream-json'] : ['exec', '--json'];
    const run = () =>
      execFileSync(process.execPath, [path.join(__dirname, 'fixtures/fake-cli.cjs'), id, ...args], {
        encoding: 'utf8',
      });
    const output = run();
    expect(run()).toBe(output);
    expect(output).toContain('input_tokens');
    expect(output).toContain('rate_limit');
    expect(
      output
        .trim()
        .split('\n')
        .every((line) => JSON.parse(line).type),
    ).toBe(true);
  },
);

it('persists the real Codex thread before delivering started for office role resolution', async () => {
  const registry = new ExecutionRegistry(root);
  req.worktreePath = path.join(root, 'worktree');
  fs.mkdirSync(req.worktreePath);
  req.role = 'reviewer';
  req.taskKey = 'SA-034';
  req.agentSpec = parse(
    fs.readFileSync(path.join(__dirname, '../../agents/templates/reviewer.yaml'), 'utf8'),
  );
  const executor = new CodexCliExecutor({
    operator: { binaryPaths: { codex: process.execPath } },
    runtimeDirectory: path.join(root, 'runtime'),
    binaryArgs: [path.join(__dirname, 'fixtures/codex-cli.cjs')],
  });
  const handle = registry.executor(executor).start(req);
  expect(handle.sessionId).toBeUndefined();
  for await (const event of handle.events) {
    if (event.type === 'started')
      expect(registry.sessionMap().get(event.sessionId)).toEqual({
        executionId: req.executionId,
        role: 'reviewer',
        taskKey: 'SA-034',
      });
    if (event.type === 'finished') expect(event.exitCode).toBe(0);
  }
});
