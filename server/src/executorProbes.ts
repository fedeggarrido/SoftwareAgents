import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ExecutorId } from '../../core/src/executorCatalog.js';
import type { ProjectOperatorConfig } from '../../core/src/project.js';
import { claudeConfigEnvironment } from './claudeConfig.js';
import {
  EXECUTOR_PROBE_MAX_BACKOFF_MS,
  EXECUTOR_PROBE_MAX_OUTPUT,
  EXECUTOR_PROBE_REFRESH_MS,
  EXECUTOR_PROBE_TIMEOUT_MS,
  EXECUTOR_PROBE_TTL_MS,
} from './constants.js';
import { resolveCodexBinary } from './executors/codexCliExecutor.js';
import { processCancellation } from './executors/processCancellation.js';
import { withoutOperatorToken } from './featureIngress.js';
import { resolveClaudeBinary } from './modelTiers.js';

/**
 * SA-089: technical availability of each Executor, observed separately from
 * authority. Probes never prompt, log in, install or generate: fixed argv, no
 * shell, cwd = tmpdir, stdin closed, bounded output and time. Only parsed facts
 * (a numeric version, a state) leave this module, never paths or CLI output.
 */

export interface ExecutorObservation {
  installation: 'ready' | 'missing' | 'unsupported' | 'unknown';
  version: string | null;
  authentication: 'ready' | 'required' | 'unknown';
  /** Epoch seconds. */
  checkedAt: number;
  staleAfter: number;
}

export interface ProbeRun {
  /** null = timed out or killed; 'missing' = the executable could not be started. */
  code: number | null | 'missing';
  output: string;
}
export type ProbeRunner = (
  file: string,
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
) => Promise<ProbeRun>;

/**
 * What each Executor must offer for its executor to launch it. Minimum versions are
 * the ones actually exercised in this repository (docs/executor-selection.md for
 * Codex, docs/research/claude-harness-spawn-formats.md for Claude); flags are the
 * ones ClaudeCliExecutor / compileCodexArgs pass. Older or unparseable = not ready.
 */
export const EXECUTOR_PROBE_CATALOG: Record<
  ExecutorId,
  { minimumTestedVersion: string; helpArgs: string[]; requiredFlags: string[] }
> = {
  claude: {
    minimumTestedVersion: '2.1.220',
    helpArgs: ['--help'],
    requiredFlags: [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--strict-mcp-config',
      '--mcp-config',
      '--setting-sources',
      '--settings',
      '--session-id',
      '--permission-mode',
      '--append-system-prompt',
      '--disable-slash-commands',
      '--tools',
      '--allowedTools',
      '--disallowedTools',
      '--no-chrome',
      '--model',
      '--effort',
    ],
  },
  codex: {
    minimumTestedVersion: '0.160.0',
    helpArgs: ['exec', '--help'],
    requiredFlags: [
      '--json',
      '--sandbox',
      '--ignore-user-config',
      '--ignore-rules',
      '--output-schema',
    ],
  },
};

/** Default runner: spawn without a shell, nothing inherited on stdin, hard limits. */
export const runProbe: ProbeRunner = (file, args, environment) =>
  new Promise((resolve) => {
    let output = '';
    let settled = false;
    let timedOut = false;
    const done = (run: ProbeRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], {
        cwd: os.tmpdir(),
        env: withoutOperatorToken({ ...process.env, ...environment }),
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ code: 'missing', output: '' });
      return;
    }
    const collect = (chunk: Buffer) => {
      if (output.length < EXECUTOR_PROBE_MAX_OUTPUT)
        output += chunk.toString('utf8').slice(0, EXECUTOR_PROBE_MAX_OUTPUT - output.length);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const cancellation = processCancellation(() => child);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        cancellation.cancel();
      } catch {
        // The cancellation helper retries within its bounded termination window.
      } finally {
        child.stdout?.destroy();
        child.stderr?.destroy();
        done({ code: null, output });
      }
    }, EXECUTOR_PROBE_TIMEOUT_MS);
    child.on('error', (error: NodeJS.ErrnoException) =>
      done({
        code: ['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code ?? '') ? 'missing' : null,
        output,
      }),
    );
    child.on('close', (code) => {
      cancellation.confirmClose();
      done({ code: timedOut ? null : code, output });
    });
  });

export function parseVersion(text: string): string | null {
  const match =
    /\d+\.\d+\.\d+(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?/.exec(
      text,
    );
  return match?.[0] ?? null;
}

export function versionAtLeast(version: string, minimum: string): boolean {
  const semver =
    /^(\d+)\.(\d+)\.(\d+)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/;
  const a = semver.exec(version);
  const b = semver.exec(minimum);
  if (!a || !b) return false;
  const compareNumeric = (x: string, y: string) =>
    x.length - y.length || (x > y ? 1 : x < y ? -1 : 0);
  for (let i = 1; i <= 3; i++) {
    const difference = compareNumeric(a[i], b[i]);
    if (difference) return difference > 0;
  }
  if (a[4] === undefined || b[4] === undefined) return b[4] !== undefined || a[4] === undefined;
  const preA = a[4].split('.');
  const preB = b[4].split('.');
  for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
    if (preA[i] === undefined || preB[i] === undefined) return preA[i] !== undefined;
    const x = preA[i];
    const y = preB[i];
    if (x === y) continue;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX !== numericY) return !numericX;
    return numericX ? compareNumeric(x, y) > 0 : x > y;
  }
  return true;
}

type ProbeResult = Omit<ExecutorObservation, 'checkedAt' | 'staleAfter'> & {
  /** A step timed out or failed unexpectedly: retry with backoff. */
  failed: boolean;
};

/** Help text lists the subcommand, so running it cannot be read as a prompt. */
function listsSubcommand(help: string, name: string): boolean {
  return new RegExp(`^\\s+${name}\\b`, 'm').test(help);
}

async function probeAuthClaude(binary: string, help: string, run: ProbeRunner) {
  if (!listsSubcommand(help, 'auth')) return { authentication: 'unknown' as const, failed: false };
  const status = await run(binary, ['auth', 'status', '--json']);
  if (status.code === null || status.code === 'missing')
    return { authentication: 'unknown' as const, failed: true };
  try {
    const loggedIn = (JSON.parse(status.output) as { loggedIn?: unknown }).loggedIn;
    if (loggedIn === true && status.code === 0)
      return { authentication: 'ready' as const, failed: false };
    if (loggedIn === false) return { authentication: 'required' as const, failed: false };
  } catch {
    /* Not the documented JSON: unknown. */
  }
  return { authentication: 'unknown' as const, failed: true };
}

async function probeAuthCodex(binary: string, run: ProbeRunner) {
  const help = await run(binary, ['login', '--help']);
  if (help.code !== 0) return { authentication: 'unknown' as const, failed: true };
  if (!listsSubcommand(help.output, 'status'))
    return { authentication: 'unknown' as const, failed: false };
  const status = await run(binary, ['login', 'status']);
  if (status.code === null || status.code === 'missing')
    return { authentication: 'unknown' as const, failed: true };
  if (
    status.code === 0 &&
    /logged in/i.test(status.output) &&
    !/not logged in/i.test(status.output)
  )
    return { authentication: 'ready' as const, failed: false };
  if (/not logged in/i.test(status.output))
    return { authentication: 'required' as const, failed: false };
  return { authentication: 'unknown' as const, failed: true };
}

export async function probeExecutor(
  executor: ExecutorId,
  binary: string,
  run: ProbeRunner = runProbe,
): Promise<ProbeResult> {
  const unknown: ProbeResult = {
    installation: 'unknown',
    version: null,
    authentication: 'unknown',
    failed: true,
  };
  const catalog = EXECUTOR_PROBE_CATALOG[executor];
  const versionRun = await run(binary, ['--version']);
  if (versionRun.code === 'missing') return { ...unknown, installation: 'missing', failed: false };
  if (versionRun.code !== 0) return unknown;
  const version = parseVersion(versionRun.output);
  if (!version) return unknown;
  if (!versionAtLeast(version, catalog.minimumTestedVersion))
    return { ...unknown, installation: 'unsupported', version, failed: false };
  const help = await run(binary, catalog.helpArgs);
  if (help.code !== 0) return { ...unknown, version };
  if (!catalog.requiredFlags.every((flag) => help.output.includes(flag)))
    return { ...unknown, installation: 'unsupported', version, failed: false };
  const auth =
    executor === 'claude'
      ? await probeAuthClaude(binary, help.output, run)
      : await probeAuthCodex(binary, run);
  return { installation: 'ready', version, ...auth };
}

/**
 * The worker is its own process: the server's monitor cache is not visible here,
 * so it probes the Executors it may launch, now, with the same rules and limits.
 */
export async function observeExecutors(
  executors: readonly ExecutorId[],
  operator: Pick<ProjectOperatorConfig, 'binaryPaths' | 'executors'>,
  run: ProbeRunner = runProbe,
  now: () => number = Date.now,
): Promise<Partial<Record<ExecutorId, ExecutorObservation>>> {
  const monitor = new ExecutorMonitor(run, now);
  const observed: Partial<Record<ExecutorId, ExecutorObservation>> = {};
  await Promise.all(
    [...new Set(executors)].map(async (id) => {
      await monitor.refresh(id, operator);
      const observation = monitor.observation(id, operator);
      if (observation) observed[id] = observation;
    }),
  );
  return observed;
}

/** Same resolution the Executors use; an invalid Operator override never falls back. */
export function resolveExecutorBinary(
  executor: ExecutorId,
  operator: Pick<ProjectOperatorConfig, 'binaryPaths'>,
): string | undefined {
  try {
    if (executor === 'codex') return resolveCodexBinary(operator);
    const configured = operator.binaryPaths?.claude;
    if (configured !== undefined) {
      if (!path.isAbsolute(configured) || !fs.statSync(configured).isFile()) return undefined;
      if (process.platform === 'win32') {
        if (!configured.toLowerCase().endsWith('.exe')) return undefined;
      } else fs.accessSync(configured, fs.constants.X_OK);
      return configured;
    }
    const resolved = resolveClaudeBinary();
    // resolveClaudeBinary echoes its input when nothing executable was found.
    return path.isAbsolute(resolved) && fs.statSync(resolved).isFile() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

interface Entry {
  observation?: ExecutorObservation;
  nextAt: number;
  failures: number;
  inflight?: Promise<boolean>;
}

/**
 * Cache keyed by Executor + resolved binary: one probe per binary per interval,
 * however many tabs or Projects ask. Disabled Executors are not refreshed; their
 * last diagnostic stays with its date.
 */
export class ExecutorMonitor {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly run: ProbeRunner = runProbe,
    private readonly now: () => number = Date.now,
  ) {}

  private key(
    executor: ExecutorId,
    operator: Pick<ProjectOperatorConfig, 'binaryPaths' | 'executors'>,
  ) {
    return `${executor}\0${resolveExecutorBinary(executor, operator) ?? '<missing>'}\0${executor === 'claude' ? (operator.executors?.claude?.configDir ?? '') : ''}`;
  }

  observation(
    executor: ExecutorId,
    operator: Pick<ProjectOperatorConfig, 'binaryPaths' | 'executors'>,
  ): ExecutorObservation | undefined {
    return this.entries.get(this.key(executor, operator))?.observation;
  }

  isDue(
    executor: ExecutorId,
    operator: Pick<ProjectOperatorConfig, 'binaryPaths' | 'executors'>,
  ): boolean {
    const entry = this.entries.get(this.key(executor, operator));
    return !entry || (!entry.inflight && entry.nextAt <= this.now());
  }

  /** Probe now; resolves true when the published observation changed. */
  refresh(
    executor: ExecutorId,
    operator: Pick<ProjectOperatorConfig, 'binaryPaths' | 'executors'>,
  ): Promise<boolean> {
    const key = this.key(executor, operator);
    const entry = this.entries.get(key) ?? { nextAt: 0, failures: 0 };
    this.entries.set(key, entry);
    if (entry.inflight) return entry.inflight;
    const binary = resolveExecutorBinary(executor, operator);
    entry.inflight = (async () => {
      const result: ProbeResult = binary
        ? await probeExecutor(executor, binary, (file, args) => {
            const environment =
              executor === 'claude'
                ? claudeConfigEnvironment(operator.executors?.claude?.configDir)
                : undefined;
            return environment ? this.run(file, args, environment) : this.run(file, args);
          }).catch(() => ({
            installation: 'unknown' as const,
            version: null,
            authentication: 'unknown' as const,
            failed: true,
          }))
        : { installation: 'missing', version: null, authentication: 'unknown', failed: false };
      const nowMs = this.now();
      entry.failures = result.failed ? entry.failures + 1 : 0;
      entry.nextAt =
        nowMs +
        Math.min(EXECUTOR_PROBE_REFRESH_MS * 2 ** entry.failures, EXECUTOR_PROBE_MAX_BACKOFF_MS);
      const facts = {
        installation: result.installation,
        version: result.version,
        authentication: result.authentication,
      };
      const previous = entry.observation;
      entry.observation = {
        ...facts,
        checkedAt: Math.floor(nowMs / 1000),
        staleAfter: Math.floor((nowMs + EXECUTOR_PROBE_TTL_MS) / 1000),
      };
      return (
        !previous ||
        previous.installation !== facts.installation ||
        previous.version !== facts.version ||
        previous.authentication !== facts.authentication ||
        previous.checkedAt !== entry.observation.checkedAt ||
        previous.staleAfter !== entry.observation.staleAfter
      );
    })().finally(() => {
      entry.inflight = undefined;
    });
    return entry.inflight;
  }
}

/** The server's one monitor (standalone CLI starts it; elsewhere it stays empty → unknown). */
export const executorMonitor = new ExecutorMonitor();

/** Re-check due Executors often enough to honour the refresh/backoff schedule. */
const MONITOR_TICK_MS = 10_000;

/**
 * Standalone CLI: probe the bound Project's ENABLED Executors at start, when due,
 * and right after an availability change; push one fresh snapshot per refresh
 * batch, including renewed timestamps. Disabled Executors are never probed in the background.
 */
export function startExecutorMonitoring(
  store: {
    on(event: 'executorStateChanged', listener: (projectId: string) => void): unknown;
    off(event: 'executorStateChanged', listener: (projectId: string) => void): unknown;
    notifyExecutorStateChanged(projectId: string): void;
  },
  bound: () => { id: string; operator: ProjectOperatorConfig | undefined } | undefined,
  monitor: ExecutorMonitor = executorMonitor,
): () => void {
  let stopped = false;
  const tick = () => {
    const project = bound();
    if (stopped || !project?.operator) return;
    const operator = project.operator;
    const refreshes: Promise<boolean>[] = [];
    for (const id of Object.keys(EXECUTOR_PROBE_CATALOG) as ExecutorId[]) {
      if (!operator.allowedExecutors.includes(id) || !monitor.isDue(id, operator)) continue;
      refreshes.push(monitor.refresh(id, operator));
    }
    void Promise.all(refreshes).then((changed) => {
      if (changed.some(Boolean) && !stopped) store.notifyExecutorStateChanged(project.id);
    });
  };
  const onChange = () => tick();
  store.on('executorStateChanged', onChange);
  const timer = setInterval(tick, MONITOR_TICK_MS);
  timer.unref();
  tick();
  return () => {
    stopped = true;
    clearInterval(timer);
    store.off('executorStateChanged', onChange);
  };
}
