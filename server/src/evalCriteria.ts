import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  EVAL_CRITERION_MAX_OUTPUT_BYTES,
  EVAL_CRITERION_TIMEOUT_MS,
  EXECUTOR_TERMINATION_TIMEOUT_MS,
} from './constants.js';
import { MANAGED_EXECUTION_ENV } from './evalGuard.js';
import { evalGit, type EvalTask } from './evalTasks.js';
import { processCancellation } from './executors/processCancellation.js';
import { resolveInside } from './pathGuard.js';

export class EvalCriterionTerminationError extends Error {
  constructor(readonly result: CriterionResult = 'timeout') {
    super('Criterion termination unconfirmed');
  }
}

/** Deliberately copy only launch essentials, never credentials, CI or Node injection flags. */
function criterionEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed =
    process.platform === 'win32' ? ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT'] : ['PATH'];
  for (const name of allowed) {
    const key = Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase());
    if (key !== undefined) env[name] = process.env[key];
  }
  return {
    ...env,
    NODE_OPTIONS: '',
    HOME: home,
    USERPROFILE: home,
    TMP: home,
    TEMP: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    CODEX_HOME: path.join(home, '.codex'),
    [MANAGED_EXECUTION_ENV]: 'eval-criteria',
  };
}

/** Drain a bounded output stream and wait for close after killing the entire process tree. */
export type CriterionResult = 'pass' | 'fail' | 'timeout';
export async function runVerifierCommand(
  argv: readonly string[],
  tree: string,
  home: string,
  timeoutMs = EVAL_CRITERION_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<CriterionResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: tree,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: criterionEnvironment(home),
    });
    const cancellation = processCancellation(() => child);
    let stopped = false;
    let timedOut = false;
    let bytes = 0;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        cancellation.cancel();
      } catch {
        // The shared cancellation helper retries. No cleanup until close confirms termination.
      }
      grace = setTimeout(() => {
        signal?.removeEventListener('abort', stop);
        reject(new EvalCriterionTerminationError(timedOut ? 'timeout' : 'fail'));
      }, EXECUTOR_TERMINATION_TIMEOUT_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const drain = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > EVAL_CRITERION_MAX_OUTPUT_BYTES) stop();
    };
    child.stdout.on('data', drain);
    child.stderr.on('data', drain);
    child.once('error', () => {
      // A failed spawn also emits close; only that event permits cleanup.
      stopped = true;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      cancellation.confirmClose();
      signal?.removeEventListener('abort', stop);
      resolve(timedOut ? 'timeout' : !stopped && code === 0 ? 'pass' : 'fail');
    });
  });
}

/** Restore pinned tests AFTER integrity validation and after the model stops.
 * Existing dependency trees are linked read-only by convention, never installed or cleaned. */
export async function checkEvalCriteria(
  task: EvalTask,
  repository: string,
  tree: string,
  scratch: string,
): Promise<boolean[]> {
  const dependencies = path.dirname(path.dirname(require.resolve('vitest/package.json')));
  const link = resolveInside(tree, 'node_modules');
  if (fs.lstatSync(link, { throwIfNoEntry: false }))
    throw new Error('Evaluation created node_modules; refusing to reuse it');
  fs.symlinkSync(dependencies, link, process.platform === 'win32' ? 'junction' : 'dir');
  // Restore every verifier before running any of them.
  for (const criterion of task.criteria) {
    const target = resolveInside(tree, criterion.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, evalGit(repository, ['show', `${task.fixCommit}:${criterion.file}`]));
  }
  const results: boolean[] = [];
  for (const criterion of task.criteria) {
    try {
      const result = await runIsolatedVitest(tree, scratch, criterion.file, criterion.testName);
      results.push(result.result === 'pass');
    } catch (error) {
      if (error instanceof EvalCriterionTerminationError) throw error;
      results.push(false);
    }
  }
  return results;
}

/** Runtime-owned profiles mirror the workspace configs without executing untrusted plugins/reporters. */
export function vitestWorkspace(tree: string, file: string, test = false) {
  const workspace = file.split('/')[0];
  if (!['server', 'webview-ui'].includes(workspace))
    throw new Error(
      `Unsupported Vitest ${test ? 'test ' : ''}root: ${JSON.stringify(file)}; expected server/ or webview-ui/`,
    );
  resolveInside(tree, file);
  return {
    root: resolveInside(tree, workspace),
    environment: 'node',
    globals: workspace === 'server',
    include: workspace === 'server' ? ['__tests__/**/*.test.ts'] : ['test/*.test.ts'],
  };
}

/** Shared neutral Vitest JSON verifier. Missing/empty reports are infrastructure, not test failures. */
export async function runIsolatedVitest(
  tree: string,
  scratch: string,
  file: string,
  testName?: string,
  signal?: AbortSignal,
  timeoutMs = EVAL_CRITERION_TIMEOUT_MS,
): Promise<{ result: 'pass' | 'fail'; passed: number; failed: number }> {
  vitestWorkspace(tree, file, true);
  return runWorkspaceVitest(tree, scratch, [file], false, timeoutMs, signal, testName);
}

export async function runRelatedVitest(
  tree: string,
  scratch: string,
  files: string[],
  timeoutMs: number,
  signal: AbortSignal,
) {
  return runWorkspaceVitest(tree, scratch, files, true, timeoutMs, signal);
}

async function runWorkspaceVitest(
  tree: string,
  scratch: string,
  files: string[],
  related: boolean,
  timeoutMs: number,
  signal?: AbortSignal,
  testName?: string,
): Promise<{ result: 'pass' | 'fail'; passed: number; failed: number }> {
  const workspace = vitestWorkspace(tree, files[0]);
  if (files.some((file) => vitestWorkspace(tree, file).root !== workspace.root))
    throw new Error('Vitest command must use a single workspace');
  const temporary = fs.mkdtempSync(path.join(scratch, 'criterion-'));
  const home = resolveInside(temporary, 'home');
  fs.mkdirSync(home);
  const setup = resolveInside(temporary, 'isolated-home.mjs');
  fs.writeFileSync(
    setup,
    `import { vi } from 'vitest';
vi.mock('os', async (original) => ({ ...(await original()), homedir: () => process.env.HOME }));
`,
  );
  const config = resolveInside(temporary, 'vitest.config.mjs');
  const report = resolveInside(temporary, 'criteria.json');
  fs.writeFileSync(
    config,
    `export default ${JSON.stringify({
      cacheDir: resolveInside(temporary, 'cache'),
      test: {
        include: related
          ? workspace.include
          : files.map((file) =>
              path.relative(workspace.root, resolveInside(tree, file)).replaceAll('\\', '/'),
            ),
        environment: workspace.environment,
        allowOnly: false,
        expect: { requireAssertions: true },
        setupFiles: [setup],
        globals: workspace.globals,
        fileParallelism: false,
        reporters: ['json'],
        outputFile: report,
        pool: 'threads',
        maxWorkers: 1,
        testTimeout: timeoutMs / 2,
      },
    })};`,
  );
  let safeToCleanup = true;
  try {
    const passed = await runVerifierCommand(
      [
        process.execPath,
        path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
        related ? 'related' : 'run',
        '--run',
        ...(related ? ['--passWithNoTests'] : []),
        '--root',
        workspace.root,
        '--config',
        config,
        '--configLoader',
        'native',
        '--no-cache',
        ...files.map((file) => resolveInside(tree, file)),
        ...(testName === undefined ? [] : ['--testNamePattern', testName]),
      ],
      workspace.root,
      home,
      timeoutMs,
      signal,
    );
    if (
      passed === 'timeout' ||
      signal?.aborted ||
      !fs.existsSync(report) ||
      fs.statSync(report).size > EVAL_CRITERION_MAX_OUTPUT_BYTES
    )
      throw new Error('Vitest infrastructure failed: timeout or missing/oversized JSON report');
    const result = JSON.parse(fs.readFileSync(report, 'utf8'));
    const suites = result.testResults?.filter(
      (suite: { name: string }) =>
        related || path.resolve(suite.name) === path.resolve(tree, files[0]),
    );
    const assertions = suites?.flatMap(
      (suite: { assertionResults: { status: string }[] }) => suite.assertionResults,
    );
    if (
      !Array.isArray(suites) ||
      (!related && (suites.length !== 1 || !assertions?.length)) ||
      (testName === undefined &&
        assertions.some((test: { status: string }) => !['passed', 'failed'].includes(test.status)))
    )
      throw new Error('Vitest infrastructure failed: missing, skipped or incomplete tests');
    const counts = {
      passed: assertions.filter((test: { status: string }) => test.status === 'passed').length,
      failed: assertions.filter((test: { status: string }) => test.status === 'failed').length,
    };
    if (
      (!related && !counts.passed && !counts.failed) ||
      (!counts.failed && (passed !== 'pass' || result.success !== true))
    )
      throw new Error('Vitest infrastructure failed without assertion failures');
    return { result: counts.failed ? 'fail' : 'pass', ...counts };
  } catch (error) {
    if (error instanceof EvalCriterionTerminationError) safeToCleanup = false;
    throw error;
  } finally {
    if (safeToCleanup) fs.rmSync(temporary, { recursive: true, force: true });
  }
}
