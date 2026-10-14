import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { parseProjects, projectConfigError } from '../src/configPersistence.js';
import { TELEMETRY_FILE_BYTES } from '../src/constants.js';
import { ClaudeCliExecutor } from '../src/executors/claudeCliExecutor.js';
import { CodexCliExecutor } from '../src/executors/codexCliExecutor.js';
import type { Executor } from '../src/executors/executor.js';
import {
  ExecutionTelemetry,
  telemetryDirectory,
  TelemetrySink,
  type TelemetrySpan,
} from '../src/telemetry.js';
import { telemetrySummary } from '../src/telemetryCommand.js';
import { CliTelemetryProjection } from '../src/telemetryObservations.js';

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: () => process.env.HOME ?? actual.homedir() };
});

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('CODEX_HOME', path.join(root, 'codex'));
  vi.stubEnv('SA_TEST_TELEMETRY', '1');
  vi.stubEnv('PIXEL_AGENTS_TOKEN', 'SERVER_TOKEN_SECRET_MARKER');
  fs.mkdirSync(path.join(root, 'worktree'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
function spans(): TelemetrySpan[] {
  const dir = telemetryDirectory(root, 'test');
  return ['spans.1.jsonl', 'spans.jsonl'].flatMap((name) => {
    const file = path.join(dir, name);
    return fs.existsSync(file)
      ? fs
          .readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line).resourceSpans[0].scopeSpans[0].spans[0])
      : [];
  });
}
function attrs(span: TelemetrySpan) {
  return Object.fromEntries(
    span.attributes.map(({ key, value }) => [
      key,
      'intValue' in value ? Number(value.intValue) : value.stringValue,
    ]),
  );
}
function trace(executor = 'claude', sink = new TelemetrySink(root, 'test'), start = Date.now()) {
  return new ExecutionTelemetry(
    sink,
    {
      executionId: 'exec-1',
      taskKey: 'SA-095',
      executor,
      agent: 'developer',
      role: 'developer',
      model: executor === 'claude' ? 'claude-test' : 'gpt-test',
      tier: 'standard',
      effort: 'high',
    },
    start,
  );
}

it.each(['claude', 'codex'])(
  'fake %s emits valid OTLP spans without content or server credentials',
  async (executor) => {
    const fake = path.join(__dirname, 'fixtures/fake-cli.cjs');
    const hook = path.join(root, 'hook.js');
    fs.writeFileSync(hook, '');
    const inner: Executor =
      executor === 'claude'
        ? new ClaudeCliExecutor({
            binary: process.execPath,
            binaryArgs: [fake, 'claude'],
            runtimeDirectory: path.join(root, 'runtime'),
            containmentHookScript: hook,
          })
        : new CodexCliExecutor({
            operator: { binaryPaths: { codex: process.execPath } },
            binaryArgs: [fake, 'codex'],
            runtimeDirectory: path.join(root, 'runtime'),
          });
    const telemetry = trace(executor);
    telemetry.phase('execution');
    const finished: number[] = [];
    for await (const event of inner.start({
      executionId: 'exec-1',
      taskKey: 'SA-095',
      projectId: 'test',
      role: 'developer',
      prompt: 'PROMPT_SECRET_MARKER SERVER_TOKEN_SECRET_MARKER',
      agentSpec: parse(
        fs.readFileSync(path.join(__dirname, '../../agents/templates/developer.yaml'), 'utf8'),
      ),
      flags: [],
      timeoutMin: 1,
      worktreePath: path.join(root, 'worktree'),
    }).events) {
      if (event.type === 'telemetry') telemetry.observe(event.observation);
      if (event.type === 'finished') finished.push(event.exitCode);
    }
    telemetry.phase('commit_guards');
    await telemetry.finish('ok');
    expect(finished).toEqual([0]);
    const records = spans();
    expect(records).toHaveLength(2);
    const parent = records.find((s) => s.name === 'invoke_agent')!;
    const child = records.find((s) => s.name === 'execute_tool')!;
    expect(parent.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(parent.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.status.code).toBe(1);
    expect(attrs(parent)).toMatchObject({
      'gen_ai.usage.input_tokens': executor === 'claude' ? 33 : 10,
      'gen_ai.usage.output_tokens': 5,
      'gen_ai.usage.cache_read.input_tokens': executor === 'claude' ? 20 : 4,
      'gen_ai.response.model': executor === 'claude' ? 'claude-test' : 'gpt-test',
      'softwareagents.model.tier': 'standard',
      'softwareagents.model.effort': 'high',
    });
    for (const s of records) {
      expect(BigInt(s.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(s.startTimeUnixNano));
      expect(s.status.code).toBe(1);
    }
    const text = JSON.stringify(records);
    for (const marker of [
      'PROMPT_SECRET_MARKER',
      'OUTPUT_SECRET_MARKER',
      'ARGUMENT_SECRET_MARKER',
      'TOOL_RESULT_SECRET_MARKER',
      'SERVER_TOKEN_SECRET_MARKER',
      'ROLLOUT_SECRET_MARKER',
      root,
    ])
      expect(text).not.toContain(marker);
  },
);

it('deduplicates Claude message usage and replaces it with result totals; errors and incomplete tools are explicit', async () => {
  const p = new CliTelemetryProjection();
  const t = trace();
  const message = {
    type: 'assistant',
    message: {
      id: 'msg',
      model: 'claude-test',
      usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 5 },
      content: [{ type: 'tool_use', id: 'call', name: 'Read', input: 'SECRET' }],
    },
  };
  for (const r of [
    message,
    message,
    { type: 'result', usage: { input_tokens: 4, output_tokens: 6, cache_read_input_tokens: 10 } },
  ])
    for (const o of p.claude(r)) t.observe(o);
  await t.finish('error');
  expect(spans()).toHaveLength(2);
  const parent = spans().find((s) => s.name === 'invoke_agent')!;
  expect(attrs(parent)['gen_ai.usage.input_tokens']).toBe(14);
  expect(parent.status.code).toBe(2);
  expect(spans()[0].status.code).toBe(2);
});

it('Codex totals, last usage and turn.completed are not counted twice, including rollout replacement', () => {
  const p = new CliTelemetryProjection();
  expect(
    p.codex({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 70 },
          last_token_usage: { input_tokens: 40, output_tokens: 10 },
        },
      },
    }),
  ).toContainEqual({ kind: 'usage', input: 100, output: 20, cacheRead: 70 });
  expect(
    p.codex({ type: 'turn.completed', usage: { input_tokens: 40, output_tokens: 10 } }),
  ).toEqual([]);
  expect(
    p.codex(
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 70 },
          },
        },
      },
      true,
    ),
  ).toContainEqual({ kind: 'usage', input: 100, output: 20, cacheRead: 70 });
});

it('export is disabled by default, ignores OTEL env config, and requires enabled=true', async () => {
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318');
  const fetch = vi.spyOn(globalThis, 'fetch');
  await trace().finish('ok');
  await trace(
    'claude',
    new TelemetrySink(root, 'test', {
      otlp: { enabled: false, endpoint: 'http://localhost:4318' },
    }),
  ).finish('ok');
  expect(fetch).not.toHaveBeenCalled();
});

it('a real failed HTTP connection and a rejected fetch never affect the run', async () => {
  const listener = http.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as import('net').AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const sink = new TelemetrySink(root, 'test', {
    otlp: { enabled: true, endpoint: `http://127.0.0.1:${port}/v1/traces` },
  });
  await expect(trace('claude', sink).finish('ok')).resolves.toBeUndefined();
  expect(spans()[0].status.code).toBe(1);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('SECRET'));
  await expect(trace('claude', sink).finish('ok')).resolves.toBeUndefined();
});

it('enabled OTLP sends a valid one-span envelope and Operator headers only', async () => {
  const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
  const sink = new TelemetrySink(root, 'test', {
    otlp: {
      enabled: true,
      endpoint: 'https://collector.invalid/v1/traces',
      headers: { Authorization: 'EXPORT_SECRET' },
    },
  });
  await trace('claude', sink).finish('ok');
  expect(send).toHaveBeenCalledWith(
    new URL('https://collector.invalid/v1/traces'),
    expect.objectContaining({
      redirect: 'error',
      headers: { Authorization: 'EXPORT_SECRET', 'Content-Type': 'application/json' },
    }),
  );
  const body = String(send.mock.calls[0][1]?.body);
  expect(JSON.parse(body).resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
  expect(body).not.toContain('EXPORT_SECRET');
  expect(JSON.stringify(spans())).not.toContain('EXPORT_SECRET');
});

it('bounds and rotates local storage, tolerates disk failure, and rejects escaping Project names', async () => {
  await trace().finish('ok');
  const dir = telemetryDirectory(root, 'test');
  const file = path.join(dir, 'spans.jsonl');
  const fd = fs.openSync(file, 'r+');
  fs.ftruncateSync(fd, TELEMETRY_FILE_BYTES);
  fs.closeSync(fd);
  await trace().finish('ok');
  expect(fs.statSync(path.join(dir, 'spans.1.jsonl')).size).toBe(TELEMETRY_FILE_BYTES);
  expect(fs.statSync(file).size).toBeLessThan(16_384);
  const blocked = path.join(root, 'blocked');
  fs.writeFileSync(blocked, 'file');
  const sink = new TelemetrySink(blocked, 'test');
  await expect(trace('claude', sink).finish('ok')).resolves.toBeUndefined();
  expect(sink.dropped).toBe(1);
  expect(() => telemetryDirectory(root, '../escape')).toThrow();
});

it('summarizes tasks/executor levels, cache rates, phases and only declared model prices', async () => {
  const t = trace('claude', undefined, 1000);
  t.observe({ kind: 'model', model: 'claude-test' });
  t.observe({ kind: 'usage', input: 100, output: 20, cacheRead: 60, cacheCreate: 10 });
  t.phase('execution', 1100);
  t.phase('commit_guards', 1500);
  await t.finish('ok', 1550);
  const unknown = await telemetrySummary(root, 'test');
  expect(unknown.total.costUsd).toBe('unknown');
  const summary = await telemetrySummary(root, 'test', 'SA-095', {
    'claude-test': { input: 2, output: 8, cacheRead: 0.2, cacheCreate: 3 },
  });
  expect(summary.total).toMatchObject({
    inputTokens: 100,
    outputTokens: 20,
    cacheHitRate: 0.6,
    phasesMs: { preparation: 100, execution: 400, commit_guards: 50 },
  });
  expect(summary.total.costUsd).toBeCloseTo((30 * 2 + 20 * 8 + 60 * 0.2 + 10 * 3) / 1_000_000);
  expect(summary.byTask['SA-095']).toEqual(summary.total);
  expect(summary.byExecutorLevel['claude/standard']).toEqual(summary.total);
  expect((await telemetrySummary(root, 'test', 'SA-999')).total.executions).toBe(0);
  expect(
    (await telemetrySummary(root, 'test', undefined, { 'claude-test': { input: 2, output: 8 } }))
      .total.costUsd,
  ).toBe('unknown');
});

it('Operator telemetry rejects content opt-in, invalid headers and negative prices', () => {
  for (const telemetry of [
    { content: true },
    { prices: { m: { input: -1, output: 1 } } },
    {
      otlp: {
        enabled: true,
        endpoint: 'https://example.invalid',
        headers: { Authorization: 'secret\r\nheader' },
      },
    },
  ]) {
    const projects = parseProjects({
      test: { autonomyLevel: 'A1', allowedExecutors: ['claude'], telemetry },
    });
    expect(projectConfigError(projects, 'test')).toBeDefined();
  }
  expect(
    parseProjects({
      test: {
        autonomyLevel: 'A1',
        allowedExecutors: ['claude'],
        telemetry: { prices: { m: { input: 0, output: 2 } } },
      },
    }).test.telemetry?.prices,
  ).toEqual({ m: { input: 0, output: 2 } });
});

it('summary before the first run is empty and does not create telemetry storage', async () => {
  const summary = await telemetrySummary(root, 'test');
  expect(summary.total.executions).toBe(0);
  expect(summary.total.costUsd).toBe('unknown');
  expect(fs.existsSync(path.join(root, 'softwareagents'))).toBe(false);
});

it('does not export dynamic tool labels or model paths', async () => {
  const p = new CliTelemetryProjection();
  const t = trace();
  for (const o of p.claude({
    type: 'assistant',
    message: {
      model: 'C:/Users/private/MODEL_SECRET_MARKER',
      content: [
        { type: 'tool_use', id: 'tool', name: 'mcp__SERVER_TOKEN_SECRET_MARKER', input: {} },
      ],
    },
  }))
    t.observe(o);
  await t.finish('ok');
  const text = JSON.stringify(spans());
  expect(text).not.toContain('SERVER_TOKEN_SECRET_MARKER');
  expect(text).not.toContain('MODEL_SECRET_MARKER');
  expect(attrs(spans()[0])['gen_ai.tool.name']).toBe('unknown');
  expect(attrs(spans()[0])['softwareagents.tool.completion']).toBe('unobserved');
});

it('unsupported usage never becomes fabricated zero tokens or zero cost', async () => {
  const p = new CliTelemetryProjection();
  expect(p.claude({ type: 'result', usage: {} })).toEqual([]);
  expect(p.codex({ type: 'turn.completed', usage: { future_usage: 10 } })).toEqual([]);
  expect(
    p.codex({
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: {} } },
    }),
  ).toEqual([]);
  await trace().finish('ok');
  const summary = await telemetrySummary(root, 'test', undefined, {
    'claude-test': { input: 1, output: 1 },
  });
  expect(summary.total.inputTokens).toBe('unknown');
  expect(summary.total.costUsd).toBe('unknown');
});
