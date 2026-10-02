import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { parse } from 'yaml';

import { CodexCliExecutor, resolveCodexBinary } from '../src/executors/codexCliExecutor.js';
import type { ExecutionEvent, ExecutionRequest } from '../src/executors/executor.js';

let root: string;
let req: ExecutionRequest;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-executor-'));
  fs.mkdirSync(path.join(root, 'worktree'));
  req = {
    executionId: 'run',
    projectId: 'project',
    taskKey: 'SA-034',
    role: 'reviewer',
    prompt: 'untrusted task',
    flags: [],
    worktreePath: path.join(root, 'worktree'),
    timeoutMin: 1,
    agentSpec: parse(
      fs.readFileSync(path.join(__dirname, '../../agents/templates/reviewer.yaml'), 'utf8'),
    ),
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function executor(mode?: string, runtimeDirectory = path.join(root, 'runtime')) {
  return new CodexCliExecutor({
    operator: { binaryPaths: { codex: process.execPath } },
    runtimeDirectory,
    binaryArgs: [path.join(__dirname, 'fixtures/codex-cli.cjs'), ...(mode ? [mode] : [])],
  });
}
async function collect(mode?: string) {
  const events: ExecutionEvent[] = [];
  for await (const event of executor(mode).start(req).events) events.push(event);
  return events;
}
it('resolves explicit Operator config before PATH and desktop discovery', () => {
  expect(resolveCodexBinary({ binaryPaths: { codex: process.execPath } }, { PATH: root })).toBe(
    process.execPath,
  );
  expect(() =>
    resolveCodexBinary({ binaryPaths: { codex: path.join(root, 'missing.exe') } }),
  ).toThrow('Invalid Operator');
});
it('resolves PATH before desktop', () => {
  const file = path.join(root, 'codex.exe');
  fs.writeFileSync(file, '');
  expect(resolveCodexBinary({}, { PATH: root, LOCALAPPDATA: root }, 'win32')).toBe(file);
});
it('selects newest desktop hash executable and reports missing installations', () => {
  const files = ['old', 'new'].map((hash) =>
    path.join(root, 'OpenAI/Codex/bin', hash, 'codex.exe'),
  );
  files.forEach((file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  });
  fs.utimesSync(files[0], new Date(1000), new Date(1000));
  expect(resolveCodexBinary({}, { PATH: '', LOCALAPPDATA: root }, 'win32')).toBe(files[1]);
  expect(() => resolveCodexBinary({}, { PATH: '' }, 'win32')).toThrow('Codex executable not found');
});
it('normalizes captured real startup and synthetic success with one usage event', async () => {
  const events = await collect();
  expect(events[0]).toMatchObject({
    type: 'started',
    sessionId: '00000000-0000-7000-a000-000000000034',
    pid: expect.any(Number),
  });
  expect(events.filter((e) => e.type === 'usage')).toEqual([
    { type: 'usage', inputTokens: 10, outputTokens: 5 },
  ]);
  expect(events.at(-1)).toEqual({ type: 'finished', exitCode: 0, resultSummary: 'Fake result' });
  expect(fs.readdirSync(path.join(root, 'runtime'))).toEqual([]);
});
it('uses compiler sandbox/config/schema and optional policy model without bypass or ephemeral', async () => {
  req.model = 'policy-model';
  req.taskData = {
    task: 'data',
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  };
  const events = await collect('--inspect');
  const report = JSON.parse((events.find((e) => e.type === 'output') as { text: string }).text);
  expect(report.args).toEqual(
    expect.arrayContaining([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--ignore-user-config',
      '--ignore-rules',
      '-C',
      req.worktreePath,
      '-m',
      'policy-model',
      '--output-schema',
    ]),
  );
  if (process.platform === 'win32')
    expect(report.args).toEqual(expect.arrayContaining(['-c', 'windows.sandbox="elevated"']));
  else expect(report.args).not.toContain('windows.sandbox="elevated"');
  expect(report.args).not.toEqual(expect.arrayContaining(['--ephemeral']));
  for (const flag of [
    '--dangerously-bypass-approvals-and-sandbox',
    'danger-full-access',
    '--ephemeral',
  ])
    expect(report.args).not.toContain(flag);
  expect(report.cwd).toBe(req.worktreePath);
  expect(report.input).toContain('SoftwareAgents constitution');
  expect(report.input).toContain('Use Codex shell commands to read');
  expect(report.input).not.toContain('No shell');
  expect(report.input).toContain('Do not create, modify or delete files');
  expect(events.at(-1)).toMatchObject({
    exitCode: 1,
    resultSummary: 'Codex output failed schema validation',
  });
});
it('uses workspace-write for Developer and leaves model unset by default', async () => {
  req.role = 'developer';
  req.agentSpec = parse(
    fs.readFileSync(path.join(__dirname, '../../agents/templates/developer.yaml'), 'utf8'),
  );
  const report = JSON.parse(
    (await collect('--inspect')).filter((e) => e.type === 'output')[0].text,
  );
  expect(report.args).toContain('workspace-write');
  expect(report.args).not.toContain('-m');
});
it('validates structured output', async () => {
  req.taskData = {
    task: 'data',
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  };
  expect((await collect('--valid-schema')).at(-1)).toMatchObject({
    exitCode: 0,
    resultSummary: '{"ok":true}',
  });
});
it('normalizes token_count and quotas without counting turn usage twice', async () => {
  const events = await collect('--token-count');
  expect(events.filter((e) => e.type === 'usage')).toHaveLength(1);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'rateLimit',
      message: 'rejected',
      retryAfterSec: expect.any(Number),
      capacity: expect.objectContaining({ provider: 'codex', source: 'codex_session_log' }),
    }),
  );
});
it('fails closed on truncated real startup without a completed turn', async () => {
  expect((await collect('--startup-only')).at(-1)).toMatchObject({ exitCode: 1 });
});
it('rejects arbitrary caller flags and missing AgentSpec', () => {
  expect(() =>
    executor().start({ ...req, flags: ['--dangerously-bypass-approvals-and-sandbox'] }),
  ).toThrow('Caller flags');
  expect(() => executor().start({ ...req, agentSpec: undefined })).toThrow('AgentSpec');
});
it('cancels before launch', async () => {
  const handle = executor().start(req);
  handle.cancel();
  const events = [];
  for await (const e of handle.events) events.push(e);
  expect(events).toEqual([{ type: 'finished', exitCode: 130, resultSummary: 'Cancelled' }]);
});
it('rejects runtime storage inside the worktree', async () => {
  await expect(
    executor(undefined, path.join(req.worktreePath, 'runtime'))
      .start(req)
      .events[Symbol.asyncIterator]()
      .next(),
  ).rejects.toThrow('outside the worktree');
});
