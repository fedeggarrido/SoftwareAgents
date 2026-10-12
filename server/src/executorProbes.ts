import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ExecutorId } from '../../core/src/executorCatalog.js';
import type { ProjectOperatorConfig } from '../../core/src/project.js';
import {
  EXECUTOR_PROBE_MAX_BACKOFF_MS,
  EXECUTOR_PROBE_MAX_OUTPUT,
  EXECUTOR_PROBE_REFRESH_MS,
  EXECUTOR_PROBE_TIMEOUT_MS,
  EXECUTOR_PROBE_TTL_MS,
} from './constants.js';
import { resolveCodexBinary } from './executors/codexCliExecutor.js';
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
export type ProbeRunner = (file: string, args: readonly string[]) => Promise<ProbeRun>;

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
      '--output-format',
      'stream-json',
      '--strict-mcp-config',
      '--mcp-config',
      '--setting-sources',
      '--settings',
      '--session-id',
      '--permission-mode',
      '--append-system-prompt',
      '--disable-slash-commands',
      '--tools',
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
export const runProbe: ProbeRunner = (file, args) =>
  new Promise((resolve) => {
    let output = '';
    let settled = false;
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
        shell: false,
        windowsHide: true,
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
    const timer = setTimeout(() => {
      child.kill();
      done({ code: null, output });
    }, EXECUTOR_PROBE_TIMEOUT_MS);
    child.on('error', (error: NodeJS.ErrnoException) =>
      done({
        code: ['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code ?? '') ? 'missing' : null,
        output,
      }),
    );
    child.on('close', (code) => done({ code, output }));
  });

export function parseVersion(text: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export function versionAtLeast(version: string, minimum: string): boolean {
  const a = version.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
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
  if (status.code === null) return { authentication: 'unknown' as const, failed: true };
  try {
    const loggedIn = (JSON.parse(status.output) as { loggedIn?: unknown }).loggedIn;
    if (loggedIn === true) return { authentication: 'ready' as const, failed: false };
    if (loggedIn === false) return { authentication: 'required' as const, failed: false };
  } catch {
    /* Not the documented JSON: unknown. */
  }
  return { authentication: 'unknown' as const, failed: false };
}

async function probeAuthCodex(binary: string, run: ProbeRunner) {
  const help = await run(binary, ['login', '--help']);
  if (help.code === null) return { authentication: 'unknown' as const, failed: true };
  if (help.code !== 0 || !listsSubcommand(help.output, 'status'))
    return { authentication: 'unknown' as const, failed: false };
  const status = await run(binary, ['login', 'status']);
  if (status.code === null) return { authentication: 'unknown' as const, failed: true };
  if (
    status.code === 0 &&
    /logged in/i.test(status.output) &&
    !/not logged in/i.test(status.output)
  )
    return { authentication: 'ready' as const, failed: false };
  if (status.code !== 0 && /not logged in/i.test(status.output))
    return { authentication: 'required' as const, failed: false };
  return { authentication: 'unknown' as const, failed: false };
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
  operator: Pick<ProjectOperatorConfig, 'binaryPaths'>,
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
    const resolved = resolveClaudeBinary(operator.binaryPaths?.claude ?? 'claude');
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

  private key(executor: ExecutorId, operator: Pick<ProjectOperatorConfig, 'binaryPaths'>) {
    return `${executor}\0${resolveExecutorBinary(executor, operator) ?? '<missing>'}`;
  }

  observation(
    executor: ExecutorId,
    operator: Pick<ProjectOperatorConfig, 'binaryPaths'>,
  ): ExecutorObservation | undefined {
    return this.entries.get(this.key(executor, operator))?.observation;
  }

  isDue(executor: ExecutorId, operator: Pick<ProjectOperatorConfig, 'binaryPaths'>): boolean {
    const entry = this.entries.get(this.key(executor, operator));
    return !entry || (!entry.inflight && entry.nextAt <= this.now());
  }

  /** Probe now; resolves true when the published observation changed. */
  refresh(
    executor: ExecutorId,
    operator: Pick<ProjectOperatorConfig, 'binaryPaths'>,
  ): Promise<boolean> {
    const key = this.key(executor, operator);
    const entry = this.entries.get(key) ?? { nextAt: 0, failures: 0 };
    this.entries.set(key, entry);
    if (entry.inflight) return entry.inflight;
    const binary = resolveExecutorBinary(executor, operator);
    entry.inflight = (async () => {
      const result: ProbeResult = binary
        ? await probeExecutor(executor, binary, this.run).catch(() => ({
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
        previous.authentication !== facts.authentication
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
 * and right after an availability change; push a fresh snapshot when a fact
 * changes. Disabled Executors are never probed in the background.
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
    for (const id of Object.keys(EXECUTOR_PROBE_CATALOG) as ExecutorId[]) {
      if (!operator.allowedExecutors.includes(id) || !monitor.isDue(id, operator)) continue;
      void monitor.refresh(id, operator).then((changed) => {
        if (changed && !stopped) store.notifyExecutorStateChanged(project.id);
      });
    }
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
