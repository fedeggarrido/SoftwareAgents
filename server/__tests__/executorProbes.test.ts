import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProjectOperatorConfig } from '../../core/src/project.js';
import { EXECUTOR_PROBE_MAX_BACKOFF_MS, EXECUTOR_PROBE_REFRESH_MS } from '../src/constants.js';
import {
  EXECUTOR_PROBE_CATALOG,
  ExecutorMonitor,
  probeExecutor,
  type ProbeRun,
  runProbe,
  startExecutorMonitoring,
  versionAtLeast,
} from '../src/executorProbes.js';
import { buildExecutorState } from '../src/executorState.js';

const claudeHelp = `Usage: claude [options]\n${EXECUTOR_PROBE_CATALOG.claude.requiredFlags.join('\n')}\nCommands:\n  auth   Manage authentication\n`;
const codexExecHelp = EXECUTOR_PROBE_CATALOG.codex.requiredFlags.join('\n');

/** Scripted CLI: every call is recorded, unknown commands fail the test loudly. */
function fakeCli(script: Record<string, ProbeRun | (() => Promise<ProbeRun>)>) {
  const calls: string[] = [];
  const run = vi.fn(async (_file: string, args: readonly string[]) => {
    const key = args.join(' ');
    calls.push(key);
    const step = script[key];
    if (!step) throw new Error(`unexpected probe: ${key}`);
    return typeof step === 'function' ? step() : step;
  });
  return { run, calls };
}
const ok = (output: string): ProbeRun => ({ code: 0, output });

describe('probeExecutor', () => {
  it('Claude: version, required flags, then auth status only because help lists it', async () => {
    const cli = fakeCli({
      '--version': ok('2.1.296 (Claude Code)'),
      '--help': ok(claudeHelp),
      'auth status --json': ok('{"loggedIn":true,"authMethod":"x","email":"secret@example"}'),
    });
    expect(await probeExecutor('claude', '/bin/claude', cli.run)).toEqual({
      installation: 'ready',
      version: '2.1.296',
      authentication: 'ready',
      failed: false,
    });
    expect(cli.calls).toEqual(['--version', '--help', 'auth status --json']);
  });

  it('Claude auth: logged out is required, anything else unknown', async () => {
    for (const [output, authentication] of [
      ['{"loggedIn":false}', 'required'],
      ['{"loggedIn":"yes"}', 'unknown'],
      ['not json', 'unknown'],
    ] as const) {
      const cli = fakeCli({
        '--version': ok('2.1.220 (Claude Code)'),
        '--help': ok(claudeHelp),
        'auth status --json': { code: 1, output },
      });
      expect(await probeExecutor('claude', '/bin/claude', cli.run)).toMatchObject({
        installation: 'ready',
        authentication,
      });
    }
  });

  it('never runs an auth subcommand the CLI does not list (it could be read as a prompt)', async () => {
    const cli = fakeCli({
      '--version': ok('2.1.300'),
      '--help': ok(claudeHelp.replace('auth   Manage', 'other  Manage')),
    });
    expect(await probeExecutor('claude', '/bin/claude', cli.run)).toMatchObject({
      installation: 'ready',
      authentication: 'unknown',
    });
    expect(cli.calls).toEqual(['--version', '--help']);
  });

  it('older than the tested minimum, missing flags, or unparseable: never ready', async () => {
    const old = fakeCli({ '--version': ok('2.1.100 (Claude Code)') });
    expect(await probeExecutor('claude', '/bin/claude', old.run)).toMatchObject({
      installation: 'unsupported',
      version: '2.1.100',
    });
    expect(old.calls).toEqual(['--version']);
    const flags = fakeCli({
      '--version': ok('2.1.296'),
      '--help': ok(claudeHelp.replace('--strict-mcp-config', '')),
    });
    expect(await probeExecutor('claude', '/bin/claude', flags.run)).toMatchObject({
      installation: 'unsupported',
    });
    const garbage = fakeCli({ '--version': ok('dev build') });
    expect(await probeExecutor('claude', '/bin/claude', garbage.run)).toMatchObject({
      installation: 'unknown',
      failed: true,
    });
  });

  it('a binary that cannot start is missing; a hung one is unknown and retried', async () => {
    const missing = fakeCli({ '--version': { code: 'missing', output: '' } });
    expect(await probeExecutor('codex', '/bin/codex', missing.run)).toMatchObject({
      installation: 'missing',
      failed: false,
    });
    const hung = fakeCli({ '--version': { code: null, output: '' } });
    expect(await probeExecutor('codex', '/bin/codex', hung.run)).toMatchObject({
      installation: 'unknown',
      failed: true,
    });
  });

  it('Codex: exec flags, then login status only when `login --help` lists it', async () => {
    const base = {
      '--version': ok('codex-cli 0.160.0'),
      'exec --help': ok(codexExecHelp),
    };
    const loggedIn = fakeCli({
      ...base,
      'login --help': ok('Commands:\n  status  Show login status\n'),
      'login status': ok('Logged in using ChatGPT'),
    });
    expect(await probeExecutor('codex', '/bin/codex', loggedIn.run)).toEqual({
      installation: 'ready',
      version: '0.160.0',
      authentication: 'ready',
      failed: false,
    });
    const loggedOut = fakeCli({
      ...base,
      'login --help': ok('Commands:\n  status  Show login status\n'),
      'login status': { code: 1, output: 'Not logged in' },
    });
    expect(await probeExecutor('codex', '/bin/codex', loggedOut.run)).toMatchObject({
      authentication: 'required',
    });
    const noStatus = fakeCli({ ...base, 'login --help': ok('Usage: codex login [options]') });
    expect(await probeExecutor('codex', '/bin/codex', noStatus.run)).toMatchObject({
      authentication: 'unknown',
    });
    expect(noStatus.calls).not.toContain('login status');
    // A prerelease of the tested version is older than it.
    const alpha = fakeCli({ '--version': ok('codex-cli 0.159.0-alpha.12.1') });
    expect(await probeExecutor('codex', '/bin/codex', alpha.run)).toMatchObject({
      installation: 'unsupported',
    });
  });

  it('compares versions numerically', () => {
    expect(versionAtLeast('2.1.296', '2.1.220')).toBe(true);
    expect(versionAtLeast('2.10.0', '2.9.9')).toBe(true);
    expect(versionAtLeast('0.159.9', '0.160.0')).toBe(false);
    expect(versionAtLeast('0.160.0', '0.160.0')).toBe(true);
  });
});

describe('runProbe (real processes)', () => {
  it('reports an executable that does not exist as missing', async () => {
    expect(await runProbe('/nonexistent/pixel-agents-probe', ['--version'])).toEqual({
      code: 'missing',
      output: '',
    });
  });

  it('runs without a shell, with stdin closed, and bounds the output', async () => {
    const run = await runProbe(process.execPath, [
      '-e',
      "process.stdout.write('x'.repeat(300000)); process.stdout.write(String(process.stdin.isTTY))",
    ]);
    expect(run.code).toBe(0);
    expect(run.output.length).toBe(128 * 1024);
    const shell = await runProbe(process.execPath, ['-e', 'console.log(process.argv[1])', '$HOME']);
    expect(shell.output.trim()).toBe('$HOME');
  });
});

describe('ExecutorMonitor', () => {
  afterEach(() => vi.useRealTimers());
  const operator = {
    binaryPaths: { claude: process.execPath, codex: process.execPath },
  } satisfies Pick<ProjectOperatorConfig, 'binaryPaths'>;

  it('dedupes concurrent probes per binary and backs off on failure up to the cap', async () => {
    let now = 1_000_000;
    let release!: (run: ProbeRun) => void;
    const run = vi.fn(
      () =>
        new Promise<ProbeRun>((resolve) => {
          release = resolve;
        }),
    );
    const monitor = new ExecutorMonitor(run, () => now);
    const a = monitor.refresh('codex', operator);
    const b = monitor.refresh('codex', operator);
    release({ code: null, output: '' }); // --version hangs
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(monitor.observation('codex', operator)).toMatchObject({
      installation: 'unknown',
      checkedAt: 1000,
      staleAfter: 1120,
    });
    expect(monitor.isDue('codex', operator)).toBe(false);
    now += 2 * EXECUTOR_PROBE_REFRESH_MS; // first failure: doubled interval
    expect(monitor.isDue('codex', operator)).toBe(true);
    for (let i = 0; i < 5; i++) {
      const next = monitor.refresh('codex', operator);
      release({ code: null, output: '' });
      await next;
    }
    now += EXECUTOR_PROBE_MAX_BACKOFF_MS - 1;
    expect(monitor.isDue('codex', operator)).toBe(false);
    now += 1;
    expect(monitor.isDue('codex', operator)).toBe(true);
  });

  it('an invalid Operator override is missing, never a fallback search', async () => {
    const run = vi.fn();
    const monitor = new ExecutorMonitor(run);
    const bad = { binaryPaths: { codex: '/nonexistent/codex', claude: '/nonexistent/claude' } };
    await monitor.refresh('codex', bad);
    await monitor.refresh('claude', bad);
    expect(run).not.toHaveBeenCalled();
    expect(monitor.observation('codex', bad)?.installation).toBe('missing');
    expect(monitor.observation('claude', bad)?.installation).toBe('missing');
  });

  it('monitoring probes only enabled Executors and pushes a snapshot when a fact changes', async () => {
    const cli = fakeCli({
      '--version': ok('2.1.296'),
      '--help': ok(claudeHelp),
      'auth status --json': ok('{"loggedIn":true}'),
    });
    const monitor = new ExecutorMonitor(cli.run);
    const listeners: ((id: string) => void)[] = [];
    const notify = vi.fn();
    const store = {
      on: (_: 'executorStateChanged', l: (id: string) => void) => listeners.push(l),
      off: vi.fn(),
      notifyExecutorStateChanged: notify,
    };
    const project = {
      id: 'test',
      operator: { autonomyLevel: 'A2', allowedExecutors: ['claude'], ...operator },
    } satisfies { id: string; operator: ProjectOperatorConfig };
    const stop = startExecutorMonitoring(store, () => project, monitor);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('test'));
    expect(monitor.observation('codex', project.operator)).toBeUndefined();
    // An availability change re-ticks; nothing is due, so nothing re-runs.
    const before = cli.calls.length;
    listeners[0]('test');
    expect(cli.calls.length).toBe(before);
    stop();
    expect(store.off).toHaveBeenCalled();
  });
});

describe('executorState with observations', () => {
  const base = {
    projectId: 'test',
    operator: {
      autonomyLevel: 'A2' as const,
      allowedExecutors: ['claude', 'codex'],
      quotaThresholds: { claude: 10, codex: 10 },
      concurrency: { maxExecutions: 2, perExecutor: { claude: 1, codex: 1 } },
    },
    snapshot: {
      allowedExecutors: ['claude', 'codex'],
      machinePolicy: {
        quotaThresholds: { claude: 10, codex: 10 },
        maxConcurrent: { claude: 1, codex: 1 },
        maxExecutions: 2,
      },
      capacities: {},
      active: { claude: 0, codex: 0 },
      nowS: 1000,
    },
    sequence: 0,
    canManage: false,
    nowS: 1000,
  };

  it('publishes facts; proven problems block, unknown and stale only flag', () => {
    const state = buildExecutorState({
      ...base,
      observations: {
        claude: {
          installation: 'ready',
          version: '2.1.296',
          authentication: 'unknown',
          checkedAt: 900,
          staleAfter: 990,
        },
        codex: {
          installation: 'missing',
          version: null,
          authentication: 'unknown',
          checkedAt: 999,
          staleAfter: 1100,
        },
      },
    });
    const [claude, codex] = state.executors;
    expect(claude).toMatchObject({
      installation: 'ready',
      version: '2.1.296',
      checkedAt: 900,
      staleAfter: 990,
      eligible: true,
    });
    expect(claude.reasonCodes).toEqual(['quota_unknown', 'probe_unknown', 'probe_stale']);
    expect(codex).toMatchObject({ installation: 'missing', eligible: false });
    expect(codex.reasonCodes).toContain('not_installed');
    const auth = buildExecutorState({
      ...base,
      observations: {
        claude: {
          installation: 'ready',
          version: '2.1.296',
          authentication: 'required',
          checkedAt: 999,
          staleAfter: 1100,
        },
      },
    }).executors[0];
    expect(auth).toMatchObject({ eligible: false });
    expect(auth.reasonCodes).toEqual(['quota_unknown', 'auth_required']);
  });
});
