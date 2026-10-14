import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProjectOperatorConfig } from '../../core/src/project.js';
import {
  EXECUTOR_PROBE_MAX_BACKOFF_MS,
  EXECUTOR_PROBE_REFRESH_MS,
  EXECUTOR_PROBE_TIMEOUT_MS,
  EXECUTOR_PROBE_TTL_MS,
  EXECUTOR_TERMINATION_TIMEOUT_MS,
} from '../src/constants.js';
import {
  ExecutorMonitor,
  parseVersion,
  probeExecutor,
  type ProbeRun,
  resolveExecutorBinary,
  runProbe,
  startExecutorMonitoring,
  versionAtLeast,
} from '../src/executorProbes.js';
import { buildExecutorState } from '../src/executorState.js';

// Fixed CLI help fixtures: independent of the catalog being checked.
const claudeHelp = `Usage: claude [options]
Options:
  -p, --print
  --output-format <format> (choices: text, json, stream-json)
  --verbose
  --strict-mcp-config
  --mcp-config <configs...>
  --setting-sources <sources>
  --settings <file-or-json>
  --session-id <uuid>
  --permission-mode <mode>
  --append-system-prompt <prompt>
  --disable-slash-commands
  --tools <tools...>
  --allowedTools <tools...>
  --disallowedTools <tools...>
  --no-chrome
  --model <model>
  --effort <level>
Commands:
  auth   Manage authentication
`;
const codexExecHelp = `Usage: codex exec [OPTIONS] [PROMPT]
Options:
  --json
  --sandbox <SANDBOX_MODE>
  --ignore-user-config
  --ignore-rules
  --output-schema <FILE>
`;

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
    for (const [output, authentication, failed] of [
      ['{"loggedIn":false}', 'required', false],
      ['{"loggedIn":"yes"}', 'unknown', true],
      ['not json', 'unknown', true],
    ] as const) {
      const cli = fakeCli({
        '--version': ok('2.1.220 (Claude Code)'),
        '--help': ok(claudeHelp),
        'auth status --json': { code: 1, output },
      });
      expect(await probeExecutor('claude', '/bin/claude', cli.run)).toMatchObject({
        installation: 'ready',
        authentication,
        failed,
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
      failed: false,
    });
    expect(cli.calls).toEqual(['--version', '--help']);
  });

  it.each([
    '--print',
    '--verbose',
    '--allowedTools',
    '--disallowedTools',
    '--no-chrome',
    '--model',
    '--effort',
  ])('Claude rejects help missing executor flag %s', async (flag) => {
    const cli = fakeCli({
      '--version': ok('2.1.296'),
      '--help': ok(claudeHelp.replace(flag, '')),
    });
    expect(await probeExecutor('claude', '/bin/claude', cli.run)).toMatchObject({
      installation: 'unsupported',
      failed: false,
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
      failed: false,
    });
    const noStatus = fakeCli({ ...base, 'login --help': ok('Usage: codex login [options]') });
    expect(await probeExecutor('codex', '/bin/codex', noStatus.run)).toMatchObject({
      authentication: 'unknown',
      failed: false,
    });
    expect(noStatus.calls).not.toContain('login status');
    // A prerelease of the tested version is older than it.
    const alpha = fakeCli({ '--version': ok('codex-cli 0.160.0-alpha.1') });
    expect(await probeExecutor('codex', '/bin/codex', alpha.run)).toMatchObject({
      installation: 'unsupported',
      version: '0.160.0-alpha.1',
    });
    expect(alpha.calls).toEqual(['--version']);
  });

  it.each(['claude', 'codex'] as const)('%s retries unexpected auth results', async (executor) => {
    for (const status of [
      { code: 1, output: 'credential service unavailable' },
      { code: 0, output: 'unrecognized status' },
      { code: 0, output: '{"loggedIn":"yes"}' },
      { code: 1, output: '{"loggedIn":true}' },
      { code: null, output: '' },
      { code: 'missing', output: '' },
    ] satisfies ProbeRun[]) {
      const cli = fakeCli({
        '--version': ok(executor === 'claude' ? '2.1.296' : '0.160.0'),
        '--help': ok(claudeHelp),
        'exec --help': ok(codexExecHelp),
        'login --help': ok('Commands:\n  status  Show login status\n'),
        'auth status --json': status,
        'login status': status,
      });
      expect(await probeExecutor(executor, '/bin/executor', cli.run)).toMatchObject({
        installation: 'ready',
        authentication: 'unknown',
        failed: true,
      });
    }
  });

  it('backs off if Codex login help fails unexpectedly', async () => {
    const cli = fakeCli({
      '--version': ok('0.160.0'),
      'exec --help': ok(codexExecHelp),
      'login --help': { code: 1, output: 'internal error' },
    });
    expect(await probeExecutor('codex', '/bin/codex', cli.run)).toMatchObject({
      authentication: 'unknown',
      failed: true,
    });
  });

  it('compares versions numerically', () => {
    expect(versionAtLeast('2.1.296', '2.1.220')).toBe(true);
    expect(versionAtLeast('2.10.0', '2.9.9')).toBe(true);
    expect(versionAtLeast('0.159.9', '0.160.0')).toBe(false);
    expect(versionAtLeast('0.160.0', '0.160.0')).toBe(true);
  });

  it('preserves prerelease and build identifiers when parsing CLI versions', () => {
    expect(parseVersion('codex-cli 0.160.0-alpha.1+build.123')).toBe('0.160.0-alpha.1+build.123');
  });

  it.each([
    ['0.160.0-alpha.1', '0.160.0', false],
    ['2.1.220-rc.1', '2.1.220', false],
    ['0.160.0', '0.160.0-rc.1', true],
    ['0.160.0-alpha.2', '0.160.0-alpha.10', false],
    ['0.160.0-alpha', '0.160.0-alpha.1', false],
    ['0.160.0-alpha.1', '0.160.0-alpha', true],
    ['0.160.0-alpha.10', '0.160.0-alpha.2', true],
    ['0.160.0-alpha.1', '0.160.0-alpha.beta', false],
    ['0.160.0-beta', '0.160.0-alpha', true],
    ['0.160.0-alpha.1', '0.160.0-alpha.1', true],
    ['0.160.0+local', '0.160.0+release', true],
    ['0.161.0-alpha.1', '0.160.0', true],
  ])('compares SemVer %s >= %s as %s', (version, minimum, expected) => {
    expect(versionAtLeast(version, minimum)).toBe(expected);
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

  it.skipIf(process.env.SA_SKIP_TASKKILL_TEST === '1')(
    'timeout kills the real process tree, including child and grandchild, within a deadline',
    async () => {
      // Self-expiry also bounds leftovers if an OS sandbox refuses tree cancellation.
      const leaf = 'setTimeout(() => process.exit(), 15000)';
      const branch = `
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], {
          stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true
        });
        console.log(child.pid);
        ${leaf};
      `;
      const root = `
        console.log(process.pid);
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(branch)}], {
          stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true
        });
        console.log(child.pid);
        ${leaf};
      `;
      const started = Date.now();
      const result = await runProbe(process.execPath, ['-e', root]);
      const pids = result.output.trim().split(/\s+/).map(Number);
      try {
        expect(result.code).toBeNull();
        expect(pids).toHaveLength(3);
        expect(pids.every((pid) => Number.isInteger(pid) && pid > 0)).toBe(true);
        await vi.waitFor(
          () => {
            for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
          },
          { timeout: 2000 },
        );
        expect(Date.now() - started).toBeLessThan(
          EXECUTOR_PROBE_TIMEOUT_MS + EXECUTOR_TERMINATION_TIMEOUT_MS,
        );
      } finally {
        for (const pid of pids.reverse()) {
          if (!Number.isInteger(pid) || pid <= 0) continue;
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already terminated */
          }
        }
      }
    },
    12_000,
  );
});

describe('ExecutorMonitor', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
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

  it('rejects relative, bare, shim and non-executable Claude overrides even with a PATH match', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-binary-'));
    const binary = path.join(directory, process.platform === 'win32' ? 'claude.exe' : 'claude');
    const shim = path.join(directory, process.platform === 'win32' ? 'claude.cmd' : 'shim');
    try {
      fs.writeFileSync(binary, 'synthetic executable', { mode: 0o700 });
      fs.writeFileSync(shim, 'non-executable shim', { mode: 0o600 });
      vi.stubEnv('PATH', directory);
      // The default really finds this binary; configured values must never search.
      expect(resolveExecutorBinary('claude', {})).toBe(fs.realpathSync.native(binary));
      expect(resolveExecutorBinary('claude', { binaryPaths: { claude: binary } })).toBe(binary);
      const run = vi.fn();
      const monitor = new ExecutorMonitor(run);
      for (const override of [
        'claude',
        'claude.exe',
        // Relative regardless of the drive: path.relative across Windows drives is absolute.
        path.join(path.basename(directory), path.basename(binary)),
        directory,
        shim,
        '',
        path.join(directory, 'missing.exe'),
      ]) {
        const bad = { binaryPaths: { claude: override } };
        await monitor.refresh('claude', bad);
        expect(monitor.observation('claude', bad)?.installation).toBe('missing');
      }
      expect(run).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['claude', 'codex'] as const)(
    '%s auth failures back off, recognized logout resets the interval',
    async (executor) => {
      let now = 1_000_000;
      let status: ProbeRun = { code: 1, output: 'credential service unavailable' };
      const cli = fakeCli({
        '--version': ok(executor === 'claude' ? '2.1.296' : '0.160.0'),
        '--help': ok(claudeHelp),
        'exec --help': ok(codexExecHelp),
        'login --help': ok('Commands:\n  status  Show login status\n'),
        'auth status --json': async () => status,
        'login status': async () => status,
      });
      const monitor = new ExecutorMonitor(cli.run, () => now);
      await monitor.refresh(executor, operator);
      now += EXECUTOR_PROBE_REFRESH_MS;
      expect(monitor.isDue(executor, operator)).toBe(false);
      now += EXECUTOR_PROBE_REFRESH_MS;
      expect(monitor.isDue(executor, operator)).toBe(true);
      await monitor.refresh(executor, operator);
      now += 2 * EXECUTOR_PROBE_REFRESH_MS;
      expect(monitor.isDue(executor, operator)).toBe(false);
      now += 2 * EXECUTOR_PROBE_REFRESH_MS;
      expect(monitor.isDue(executor, operator)).toBe(true);
      status = { code: 1, output: executor === 'claude' ? '{"loggedIn":false}' : 'Not logged in' };
      await monitor.refresh(executor, operator);
      expect(monitor.observation(executor, operator)?.authentication).toBe('required');
      now += EXECUTOR_PROBE_REFRESH_MS;
      expect(monitor.isDue(executor, operator)).toBe(true);
    },
  );

  it('broadcasts one snapshot per healthy refresh batch, renewing dates beyond the initial TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const cli = fakeCli({
      '--version': ok('2.1.296'),
      '--help': ok(claudeHelp),
      'auth status --json': ok('{"loggedIn":true}'),
      'exec --help': ok(codexExecHelp),
      'login --help': ok('Commands:\n  status  Show login status\n'),
      'login status': ok('Logged in using ChatGPT'),
    });
    const monitor = new ExecutorMonitor(cli.run);
    const project = {
      id: 'test',
      operator: { autonomyLevel: 'A2', allowedExecutors: ['claude', 'codex'], ...operator },
    } satisfies { id: string; operator: ProjectOperatorConfig };
    let listener: (id: string) => void = () => {};
    let snapshot: ReturnType<typeof monitor.observation>;
    const notify = vi.fn(() => {
      snapshot = monitor.observation('claude', project.operator);
      listener(project.id); // The real store emits the same event synchronously.
    });
    const store = {
      on: (_: 'executorStateChanged', callback: (id: string) => void) => {
        listener = callback;
      },
      off: vi.fn(),
      notifyExecutorStateChanged: notify,
    };
    const stop = startExecutorMonitoring(store, () => project, monitor);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(notify).toHaveBeenCalledTimes(1);
      const original = snapshot!;
      expect(original.checkedAt).toBe(1000);
      for (let refresh = 1; refresh <= 3; refresh++) {
        await vi.advanceTimersByTimeAsync(EXECUTOR_PROBE_REFRESH_MS);
        expect(notify).toHaveBeenCalledTimes(refresh + 1);
        expect(snapshot).toEqual({
          ...original,
          checkedAt: 1000 + (refresh * EXECUTOR_PROBE_REFRESH_MS) / 1000,
          staleAfter: 1000 + (refresh * EXECUTOR_PROBE_REFRESH_MS + EXECUTOR_PROBE_TTL_MS) / 1000,
        });
        expect(snapshot!.staleAfter).toBeGreaterThan(Date.now() / 1000);
      }
      expect(Date.now() / 1000).toBeGreaterThan(original.staleAfter);
      expect(cli.run).toHaveBeenCalledTimes(4 * 7); // both Executors, once per batch
    } finally {
      stop();
    }
    await vi.advanceTimersByTimeAsync(EXECUTOR_PROBE_REFRESH_MS);
    expect(notify).toHaveBeenCalledTimes(4);
  });

  it('monitoring probes only enabled Executors and pushes a fresh snapshot', async () => {
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
