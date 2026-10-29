import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { CodexCliExecutor, resolveCodexBinary } from '../src/executors/codexCliExecutor.js';
import { ExecutionRegistry } from '../src/executors/executionRegistry.js';
import type { ExecutionEvent, ExecutionRequest } from '../src/executors/executor.js';

// Native taskkill is unavailable in restricted sandboxes. Fixtures self-close in this mode;
// executorTermination.test.ts verifies failed kills and retries with simulated processes.
vi.mock('child_process', async (original) => {
  const actual = await original<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: (file: string, ...args: unknown[]) => {
      if (file === 'taskkill' && process.env.SA_SKIP_TASKKILL_TEST === '1') return Buffer.alloc(0);
      return Reflect.apply(actual.execFileSync, actual, [file, ...args]);
    },
  };
});

let root: string;
let req: ExecutionRequest;
vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: () => process.env.HOME ?? actual.homedir() };
});
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-executor-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('FAKE_CODEX_SESSIONS', path.join(root, 'sessions'));
  fs.mkdirSync(path.join(root, 'worktree'));
  req = {
    executionId: 'run',
    projectId: 'project',
    taskKey: 'SA-034',
    role: 'architect',
    prompt: 'untrusted task',
    flags: [],
    worktreePath: path.join(root, 'worktree'),
    timeoutMin: 1,
    agentSpec: parse(
      fs.readFileSync(path.join(__dirname, '../../agents/templates/architect.yaml'), 'utf8'),
    ),
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
function executor(mode?: string, runtimeDirectory = path.join(root, 'runtime')) {
  return new CodexCliExecutor({
    operator: { binaryPaths: { codex: process.execPath } },
    runtimeDirectory,
    binaryArgs: [path.join(__dirname, 'fixtures/codex-cli.cjs'), ...(mode ? [mode] : [])],
    sessionsDirectory: path.join(root, 'sessions'),
  });
}
async function collect(mode?: string) {
  const events: ExecutionEvent[] = [];
  for await (const event of executor(mode).start(req).events) events.push(event);
  return events;
}
it.each(['--usage-limit', '--quota-stderr'])('normalizes quota diagnostic %s', async (mode) => {
  expect(await collect(mode)).toContainEqual({
    type: 'rateLimit',
    message: 'rejected',
    retryAfterSec: 0,
  });
});
it.each(['qa', 'reviewer'])('refuses %s before creating a process or runtime directory', (role) => {
  expect(() => executor().start({ ...req, role })).toThrow('code_execution_not_mediated');
  expect(fs.existsSync(path.join(root, 'runtime'))).toBe(false);
});
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
  expect(report.args[report.args.indexOf('web_search="disabled"') - 1]).toBe('-c');
  for (const feature of ['apps', 'plugins', 'tool_suggest', 'browser_use'])
    expect(report.args[report.args.indexOf(`features.${feature}=false`) - 1]).toBe('-c');
  expect(report.args).not.toContain('--search');
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
it.each([
  ['--web-search', 'web_search'],
  ['--web-search-envelope', 'web_search_begin'],
])(
  'stops and fails the run when Codex searches the web despite the policy (%s)',
  async (mode, seen) => {
    const events = await collect(mode);
    const summary = `Policy violation: Codex used ${seen} despite web_search="disabled"; slice profiles have no web access`;
    expect(events).toContainEqual({ type: 'output', stream: 'stdout', text: summary });
    expect(events.at(-1)).toEqual({ type: 'finished', exitCode: 1, resultSummary: summary });
  },
);
it.each([
  ['--mcp-call', 'codex_apps.gmail_send_email'],
  ['--mcp-envelope', 'codex_apps.search_service.web_run'],
])('stops and fails the run when Codex calls an MCP tool (%s)', async (mode, tool) => {
  const events = await collect(mode);
  const summary = `Policy violation: Codex called MCP tool ${tool} despite features apps, plugins, remote_plugin, tool_suggest, skill_mcp_dependency_install, browser_use, browser_use_external, browser_use_full_cdp_access, in_app_browser off; slice profiles have no MCP`;
  expect(events).toContainEqual({ type: 'output', stream: 'stdout', text: summary });
  expect(events.at(-1)).toEqual({ type: 'finished', exitCode: 1, resultSummary: summary });
});
it.each([
  [
    '--collab',
    'Codex delegated to a sub-agent (spawn_agent); slice profiles have no delegated agents',
  ],
  [
    '--spawn-subagent',
    'Codex spawned a sub-agent (rollout-fake-child.jsonl); slice profiles have no delegated agents',
  ],
])('stops and fails the run when Codex delegates to a sub-agent (%s)', async (mode, detail) => {
  vi.stubEnv('FAKE_CODEX_SESSIONS', path.join(root, 'sessions'));
  try {
    const events = await collect(mode);
    const summary = `Policy violation: ${detail}`;
    expect(events).toContainEqual({ type: 'output', stream: 'stdout', text: summary });
    expect(events.at(-1)).toEqual({ type: 'finished', exitCode: 1, resultSummary: summary });
  } finally {
    vi.unstubAllEnvs();
  }
});
it('refuses a worktree that ships Codex configuration or skills before returning a handle', () => {
  for (const shipped of ['.codex', '.agents']) {
    fs.mkdirSync(path.join(req.worktreePath, shipped));
    expect(() => executor().start(req)).toThrow(`the worktree ships ${shipped}/`);
    fs.rmSync(path.join(req.worktreePath, shipped), { recursive: true });
  }
});
it.each(['--web-search', '--mcp-call', '--collab'])(
  'never persists forbidden arguments in the ExecutionRegistry (%s)',
  async (mode) => {
    execFileSync('git', ['init'], { cwd: req.worktreePath });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'base',
      ],
      { cwd: req.worktreePath },
    );
    const events: ExecutionEvent[] = [];
    for await (const event of new ExecutionRegistry(req.worktreePath)
      .executor(executor(mode))
      .start(req).events)
      events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'finished', exitCode: 1 });
    expect(events.some((event) => event.type === 'toolUse')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('TEST_SECRET');
    expect(
      fs.readFileSync(path.join(req.worktreePath, '.git/softwareagents/runs/run.jsonl'), 'utf8'),
    ).not.toContain('TEST_SECRET');
  },
);

it('ignores incomplete concurrent sessions created before launch even if still writing', async () => {
  const day = new Date();
  const folder = path.join(
    root,
    'sessions',
    String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, '0'),
    String(day.getDate()).padStart(2, '0'),
  );
  fs.mkdirSync(folder, { recursive: true });
  // It is created before launch; a future mtime ensures it is within the watched interval.
  const file = path.join(folder, 'rollout-incomplete.jsonl');
  fs.writeFileSync(file, '{"type":"session_meta"');
  fs.utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect((await collect()).at(-1)).toMatchObject({
    exitCode: 0,
  });
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
  ).resolves.toMatchObject({
    value: {
      type: 'finished',
      exitCode: 1,
      resultSummary: expect.stringContaining('outside the worktree'),
    },
  });
});
