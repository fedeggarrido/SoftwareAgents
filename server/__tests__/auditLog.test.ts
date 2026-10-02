import { spawn } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { type AuditInput, AuditLog, recordAudit, redactAudit } from '../src/auditLog.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => process.env.HOME ?? actual.homedir()) };
});
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()) }));

const input: AuditInput = {
  projectId: 'sample',
  actorType: 'agent',
  actorId: 'developer',
  action: 'worker.run',
  resourceType: 'task',
  resourceId: 'SA-022',
  policyDecision: { outcome: 'allow', reason: 'A2' },
  riskLevel: 'low',
  outcome: { status: 'success' },
  taskKey: 'SA-022',
  executionId: 'run-1',
};

describe('AuditLog', () => {
  let home: string;
  let originalHome: string | undefined;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('appends without replacing existing bytes and preserves correlation fields for sinks', () => {
    const sink = { append: vi.fn() };
    const log = new AuditLog([sink]);
    const first = log.append(input);
    const prefix = fs.readFileSync(log.file('sample'), 'utf8');
    const second = log.append(input);
    expect(first.id).not.toBe(second.id);
    expect(fs.readFileSync(log.file('sample'), 'utf8').startsWith(prefix)).toBe(true);
    expect(log.read('sample')).toHaveLength(2);
    expect(sink.append).toHaveBeenLastCalledWith(
      expect.objectContaining({
        taskKey: 'SA-022',
        executionId: 'run-1',
        policyDecision: input.policyDecision,
      }),
    );
  });

  it('redacts discovery tokens, URLs, Authorization and key patterns before disk and sinks', () => {
    const dir = path.join(home, '.pixel-agents');
    fs.mkdirSync(path.join(dir, 'servers'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'server.json'),
      JSON.stringify({ authToken: 'opaque-server-secret', token: 'actual-runtime-secret' }),
    );
    fs.writeFileSync(
      path.join(dir, 'servers', '123-456.json'),
      JSON.stringify({ token: 'other-runtime-secret' }),
    );
    const detail =
      'opaque-server-secret actual-runtime-secret other-runtime-secret https://localhost/?token=url-secret&x=1 Authorization: Bearer bearer-secret; pk_private sk-private ghp_private github_pat_private';
    const sink = { append: vi.fn() };
    const log = new AuditLog([sink]);
    const entry = log.append({
      ...input,
      outcome: { status: 'failure', detail },
      input: { Authorization: 'hidden', nested: { apiKey: 'hidden' } },
    });
    const serialized =
      fs.readFileSync(log.file('sample'), 'utf8') + JSON.stringify(sink.append.mock.calls);
    for (const secret of [
      'opaque-server-secret',
      'actual-runtime-secret',
      'other-runtime-secret',
      'url-secret',
      'bearer-secret',
      'pk_private',
      'sk-private',
      'ghp_private',
      'github_pat_private',
      'hidden',
    ])
      expect(serialized).not.toContain(secret);
    expect(entry.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(redactAudit('{"Authorization": "Bearer secret"}')).not.toContain('Bearer secret');
  });

  it('marks malformed and invalid-schema lines and isolates a crash-truncated tail', () => {
    const log = new AuditLog();
    log.append(input);
    fs.appendFileSync(log.file('sample'), 'bad-json\n{}\n{"partial":');
    log.append(input);
    expect(log.read('sample').map((line) => line.corrupt)).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
    expect(log.read(null)).toEqual([]);
  });

  it.each(['../escape', 'a/b', 'CON', 'C:escape'])('rejects unsafe file ID %s', (projectId) => {
    expect(() => new AuditLog().append({ ...input, projectId })).toThrow(
      'Invalid audit project ID',
    );
  });

  it('times out without stealing an existing lock or modifying the log', () => {
    const log = new AuditLog();
    log.append(input);
    const before = fs.readFileSync(log.file('sample'), 'utf8');
    fs.writeFileSync(log.file('sample') + '.lock', 'existing owner');
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 5001));
    expect(() => log.append(input)).toThrow('Audit lock timeout');
    expect(fs.readFileSync(log.file('sample'), 'utf8')).toBe(before);
    expect(fs.readFileSync(log.file('sample') + '.lock', 'utf8')).toBe('existing owner');
  });

  it('releases the lock after a failed write and reports persistence failure without payloads', () => {
    const log = new AuditLog();
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('secret-error');
    });
    expect(() => log.append(input)).toThrow('secret-error');
    expect(fs.existsSync(log.file('sample') + '.lock')).toBe(false);
    write.mockImplementationOnce(() => {
      throw new Error('secret-error');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    recordAudit('test', 'test', null, { status: 'failure' });
    expect(error).toHaveBeenCalledWith('[Pixel Agents] Audit persistence failed');
    write.mockRestore();
    log.append(input);
    expect(log.read('sample')).toHaveLength(1);
  });

  it('serializes simultaneous appends from two real Node processes', async () => {
    const bundle = path.join(home, 'audit.cjs');
    const result = buildSync({
      entryPoints: [path.resolve(__dirname, '../src/auditLog.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
    });
    fs.writeFileSync(bundle, result.outputFiles[0].text);
    const script =
      "require('os').homedir = () => process.env.HOME; const { AuditLog } = require(process.argv[1]); const input = JSON.parse(process.argv[2]); process.on('message', () => { try { for(let i=0;i<100;i++) new AuditLog().append({...input, resourceId: process.pid + ':' + i, input: 'x'.repeat(16000)}); process.exit(0); } catch(e) { console.error(e); process.exit(1); } }); process.send('ready');";
    const children = [0, 1].map(() =>
      spawn(process.execPath, ['-e', script, bundle, JSON.stringify(input)], {
        env: { ...process.env, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      }),
    );
    try {
      const exits = children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            let stderr = '';
            child.stderr!.on('data', (data) => {
              stderr += String(data);
            });
            child.on('error', reject);
            child.on('exit', (code) =>
              code === 0 ? resolve() : reject(new Error(stderr || 'Child failed: ' + code)),
            );
          }),
      );
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve, reject) => {
              child.once('message', () => resolve());
              child.once('error', reject);
            }),
        ),
      );
      children.forEach((child) => child.send('start'));
      await Promise.all(exits);
      const lines = new AuditLog().read('sample');
      expect(lines).toHaveLength(200);
      expect(lines.every((line) => !line.corrupt)).toBe(true);
      expect(
        new Set(lines.flatMap((line) => (line.corrupt ? [] : [line.entry.resourceId]))).size,
      ).toBe(200);
      expect(fs.existsSync(new AuditLog().file('sample') + '.lock')).toBe(false);
    } finally {
      children.forEach((child) => {
        if (child.exitCode === null) child.kill();
      });
    }
  }, 20_000);

  it('audits actual terminal launch dispatch and failure without claiming an Execution ID', async () => {
    const source = buildSync({
      entryPoints: [path.resolve(__dirname, '../../adapters/vscode/agentManager.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      external: ['vscode'],
    }).outputFiles[0].text;
    const terminal = { show: vi.fn(), sendText: vi.fn(), name: 'test' };
    const vscode = {
      workspace: { workspaceFolders: [] },
      window: { createTerminal: vi.fn(() => terminal) },
    };
    const nodeRequire = createRequire(path.resolve(__dirname, '../../package.json'));
    const module = { exports: {} as typeof import('../../adapters/vscode/agentManager.js') };
    // Load the real adapter with an inert VS Code surface and isolated home.
    new Function('require', 'module', 'exports', source)(
      (name: string) =>
        name === 'vscode'
          ? vscode
          : name === 'os'
            ? { ...os, homedir: () => home }
            : nodeRequire(name),
      module,
      module.exports,
    );
    const store = new AgentStateStore();
    const scan = { current: null as ReturnType<typeof setInterval> | null };
    const polls = new Map<number, ReturnType<typeof setInterval>>();
    vi.useFakeTimers();
    try {
      await module.exports.launchNewTerminal(
        { current: 1 },
        { current: 1 },
        store,
        { current: null },
        new Set(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        polls,
        scan,
        () => {},
        home,
      );
      terminal.sendText.mockImplementationOnce(() => {
        throw new Error('launch failed');
      });
      await expect(
        module.exports.launchNewTerminal(
          { current: 2 },
          { current: 2 },
          store,
          { current: null },
          new Set(),
          new Map(),
          new Map(),
          new Map(),
          new Map(),
          polls,
          scan,
          () => {},
          home,
        ),
      ).rejects.toThrow('launch failed');
      expect(
        new AuditLog()
          .read(null)
          .map((line) =>
            line.corrupt
              ? null
              : [line.entry.action, line.entry.outcome.status, line.entry.executionId],
          ),
      ).toEqual([
        ['launchAgent', 'dispatched', null],
        ['launchAgent', 'failure', null],
      ]);
      expect(terminal.sendText).toHaveBeenCalledTimes(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      store.dispose();
    }
  });
});
