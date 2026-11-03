import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { AuditLog } from '../src/auditLog.js';
import { dispatchCli } from '../src/cli.js';
import { runDesignCommand } from '../src/commands/design.js';
import { runFeatureCommand } from '../src/commands/feature.js';
import { runLearningCommand } from '../src/commands/learning.js';
import { runResearchCommand } from '../src/commands/research.js';
import { runReviewCommand } from '../src/commands/review.js';
import { runTaskCommand } from '../src/commands/task.js';
import { runEvalCommand } from '../src/evalCommand.js';
import {
  confirmHumanIngress,
  readOperatorToken,
  withoutOperatorToken,
} from '../src/featureIngress.js';
import {
  createHttpServer,
  type HttpServerHandle,
  type HttpServerOptions,
} from '../src/httpServer.js';
import { loadProjectConfig } from '../src/projectConfig.js';
import { runUsageCommand } from '../src/usageCommand.js';
import * as workstore from '../src/workstore/SqliteWorkStore.js';

vi.mock('../src/projectConfig.js', () => ({ loadProjectConfig: vi.fn(() => undefined) }));
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));
let home: string;
let server: HttpServerHandle;
let serverOptions: HttpServerOptions;
const token = 'test-operator-capability';
beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'human-ingress-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  for (const key of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(key, undefined);
  vi.stubEnv('CI', undefined);
  serverOptions = { embedded: true, token, store: new AgentStateStore() };
  server = await createHttpServer(serverOptions);
  fs.mkdirSync(path.join(home, '.pixel-agents'));
  writeDiscovery();
  vi.stubEnv('PIXEL_AGENTS_OPERATOR_TOKEN', token);
  vi.spyOn(workstore, 'openWorkStore');
  vi.spyOn(AuditLog.prototype, 'append');
});
function writeDiscovery(value: unknown = { pid: process.pid, port: server.port, token }) {
  fs.writeFileSync(path.join(home, '.pixel-agents/server.json'), JSON.stringify(value));
}
afterEach(async () => {
  await server?.app.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const decisions = [
  () => runFeatureCommand(['run', 'FEAT-001']),
  () => runFeatureCommand(['approve', 'FEAT-001']),
  () => runFeatureCommand(['rebase', 'FEAT-001', '--task', 'FEAT-001-T01']),
  () => runFeatureCommand(['spec', 'FEAT-001', '--answers', 'answers.md']),
  () => runFeatureCommand(['design', 'FEAT-001', '--answers', 'answers.md']),
  () => runLearningCommand(['approve', 'a'.repeat(24)]),
  () => runLearningCommand(['reject', 'a'.repeat(24)]),
  () => runReviewCommand(['finding', 'T', '0', '--accept']),
  () => runReviewCommand(['finding', 'T', '0', '--reject']),
  () => runDesignCommand(['review']),
  () => runDesignCommand(['direction']),
  () => runDesignCommand(['apply-direction', '--decision', 'D']),
  () => runResearchCommand(['run', '--question', 'Question']),
  () => runTaskCommand(['retry', 'FEAT-001-T01']),
  () => runUsageCommand(['backfill']),
  () => dispatchCli(['worker', 'run', '--task', 'SA-107']),
  () =>
    runEvalCommand([
      'run',
      '--task',
      'answer',
      '--executor',
      'codex',
      '--tier',
      'economy',
      '--repeat',
      '1',
      '--yes',
    ]),
];

it.each(decisions.map((run, index) => ({ run, index })))(
  'rejects decision $index without markers or a valid token, before any writes',
  async ({ run }) => {
    const before = fs.readdirSync(path.join(home, '.pixel-agents'));
    vi.mocked(loadProjectConfig).mockClear();
    vi.stubEnv('PIXEL_AGENTS_OPERATOR_TOKEN', undefined);
    await expect(run()).rejects.toThrow('PIXEL_AGENTS_OPERATOR_TOKEN');
    vi.stubEnv('PIXEL_AGENTS_OPERATOR_TOKEN', 'incorrect-secret');
    await expect(run()).rejects.toThrow('Invalid operator token');
    expect(fs.readdirSync(path.join(home, '.pixel-agents'))).toEqual(before);
    expect(loadProjectConfig).not.toHaveBeenCalled();
    expect(workstore.openWorkStore).not.toHaveBeenCalled();
    expect(AuditLog.prototype.append).not.toHaveBeenCalled();
  },
);

it('accepts the current capability, strips only trailing --confirm, and rejects rotation', async () => {
  await expect(confirmHumanIngress(['approve', 'F', '--confirm'])).resolves.toEqual([
    'approve',
    'F',
  ]);
  fs.writeFileSync(
    path.join(home, '.pixel-agents/server.json'),
    JSON.stringify({ pid: process.pid, port: server.port, token: 'rotated' }),
  );
  await expect(confirmHumanIngress([])).rejects.toThrow('Invalid operator token');
});

it('admits a confirmed direct worker launch without invoking a real executor', async () => {
  const worker = vi.fn(async () => ({ branch: 'test', commit: null, stat: '' }));
  await dispatchCli(['worker', 'run', '--task', 'SA-107', '--confirm'], {
    worker,
    server: vi.fn(async () => {}),
  });
  expect(worker).toHaveBeenCalledWith(expect.objectContaining({ task: 'SA-107' }));
});

it.each([
  'missing',
  'unreadable',
  'malformed',
  'invalid shape',
  'dead PID',
  'unrelated live PID',
  'proof mismatch',
])('rejects %s discovery before every mutation sink', async (scenario) => {
  const record = path.join(home, '.pixel-agents/server.json');
  if (scenario === 'missing') fs.unlinkSync(record);
  if (scenario === 'unreadable') {
    fs.unlinkSync(record);
    fs.mkdirSync(record);
  }
  if (scenario === 'malformed') fs.writeFileSync(record, '{');
  if (scenario === 'invalid shape') writeDiscovery({ pid: process.pid, port: 0, token });
  if (scenario === 'dead PID')
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error(), { code: 'ESRCH' });
    });
  if (scenario === 'unrelated live PID') await server.app.close();
  if (scenario === 'proof mismatch') serverOptions.token = 'unrelated-secret';
  vi.mocked(loadProjectConfig).mockClear();
  for (const run of decisions) await expect(run()).rejects.toThrow('PIXEL_AGENTS_OPERATOR_TOKEN');
  expect(loadProjectConfig).not.toHaveBeenCalled();
  expect(workstore.openWorkStore).not.toHaveBeenCalled();
  expect(AuditLog.prototype.append).not.toHaveBeenCalled();
  expect(fs.readdirSync(home)).toEqual(['.pixel-agents']);
});

it('rejects forged HOME and USERPROFILE without a live proof server', async () => {
  await server.app.close();
  const forged = path.join(home, 'forged');
  fs.mkdirSync(path.join(forged, '.pixel-agents'), { recursive: true });
  fs.writeFileSync(
    path.join(forged, '.pixel-agents/server.json'),
    JSON.stringify({ pid: process.pid, port: server.port, token: 'invented' }),
  );
  vi.stubEnv('HOME', forged);
  vi.stubEnv('USERPROFILE', forged);
  vi.stubEnv('PIXEL_AGENTS_OPERATOR_TOKEN', 'invented');
  await expect(confirmHumanIngress([])).rejects.toThrow('PIXEL_AGENTS_OPERATOR_TOKEN');
});

it.each(['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])(
  'does not let the token override %s',
  async (marker) => {
    vi.stubEnv(marker, '1');
    await expect(confirmHumanIngress([])).rejects.toThrow('human ingress');
  },
);

it('never logs or audits credentials, including invalid input', async () => {
  const log = vi.spyOn(console, 'log');
  const error = vi.spyOn(console, 'error');
  await expect(confirmHumanIngress([])).resolves.toEqual([]);
  vi.stubEnv('PIXEL_AGENTS_OPERATOR_TOKEN', 'incorrect-secret');
  await expect(confirmHumanIngress([])).rejects.toThrow('Invalid operator token');
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(fs.readdirSync(path.join(home, '.pixel-agents'))).toEqual(['server.json']);
});

it('removes credentials after overrides, including Windows casing, without mutating the parent', () => {
  const env = {
    PIXEL_AGENTS_OPERATOR_TOKEN: 'secret',
    pixel_agents_operator_token: 'override',
    PATH: 'p',
  };
  expect(withoutOperatorToken(env)).toEqual({ PATH: 'p' });
  expect(env.PIXEL_AGENTS_OPERATOR_TOKEN).toBe('secret');
});

it.each(['\r', '\u0003', '\u0004'])('hides TTY input and restores raw mode on %j', async (end) => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn(),
  });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  let displayed = '';
  output.on('data', (chunk) => {
    displayed += chunk.toString();
  });
  const token = readOperatorToken(
    input as unknown as typeof process.stdin,
    output as unknown as typeof process.stderr,
  );
  // Attach the rejection handler before feeding a cancellation.
  const result =
    end === '\r'
      ? expect(token).resolves.toBe('secret')
      : expect(token).rejects.toThrow('cancelled');
  input.write(`secreX\u007ft${end}`);
  await result;
  expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
  expect(displayed).toBe('Operator server token (hidden): \n');
  expect(input.listenerCount('data')).toBe(0);
  expect(input.isPaused()).toBe(true);
});

it('rejects piped input without reading it', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: false, setRawMode: vi.fn() });
  expect(() => readOperatorToken(input as unknown as typeof process.stdin)).toThrow('TTY');
  expect(input.setRawMode).not.toHaveBeenCalled();
});

it.each([
  () => runFeatureCommand(['show', 'FEAT-001']),
  () => runLearningCommand(['list']),
  () => runReviewCommand(['precision']),
  () => runTaskCommand(['list']),
  () => runUsageCommand([]),
  () => runUsageCommand(['backfill', '--dry-run']),
])('leaves read commands independent of operator credentials', async (run) => {
  vi.stubEnv('PIXEL_AGENTS_OPERATOR_TOKEN', undefined);
  await expect(run()).rejects.toThrow(/bound|requires/);
  await expect(run()).rejects.not.toThrow(/token|confirmation/i);
});
