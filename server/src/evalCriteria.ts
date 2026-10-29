import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  EVAL_CRITERION_MAX_OUTPUT_BYTES,
  EVAL_CRITERION_TIMEOUT_MS,
  EXECUTOR_TERMINATION_TIMEOUT_MS,
} from './constants.js';
import { MANAGED_EXECUTION_ENV } from './evalGuard.js';
import { EvalIntegrityError } from './evalIntegrity.js';
import { evalGit, type EvalTask } from './evalTasks.js';
import { processCancellation } from './executors/processCancellation.js';
import { resolveInside } from './pathGuard.js';
import { testDiscovery } from './testRoots.js';
import { VerifierInfrastructureError } from './verifierInfrastructure.js';

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
export type CriterionResult = 'pass' | 'fail' | 'timeout' | 'not_tested';
export async function runVerifierCommand(
  argv: readonly string[],
  tree: string,
  home: string,
  timeoutMs = EVAL_CRITERION_TIMEOUT_MS,
  signal?: AbortSignal,
  onOutput?: (output: string) => void,
  /** Runtime-owned private index when materializing a pinned Git baseline. */
  gitIndexFile?: string,
): Promise<CriterionResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: tree,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...criterionEnvironment(home),
        ...(gitIndexFile ? { GIT_INDEX_FILE: gitIndexFile } : {}),
      },
    });
    const cancellation = processCancellation(() => child);
    let stopped = false;
    let timedOut = false;
    let spawnFailed = false;
    let bytes = 0;
    const output: Buffer[] = [];
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
      const previousBytes = bytes;
      bytes += chunk.length;
      if (onOutput && previousBytes < EVAL_CRITERION_MAX_OUTPUT_BYTES)
        output.push(chunk.subarray(0, EVAL_CRITERION_MAX_OUTPUT_BYTES - previousBytes));
      if (bytes > EVAL_CRITERION_MAX_OUTPUT_BYTES) stop();
    };
    child.stdout.on('data', drain);
    child.stderr.on('data', drain);
    child.once('error', (error) => {
      // A failed spawn also emits close; only that event permits cleanup.
      stopped = true;
      spawnFailed = true;
      if (onOutput) output.push(Buffer.from(error.message));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      cancellation.confirmClose();
      signal?.removeEventListener('abort', stop);
      onOutput?.(Buffer.concat(output).toString('utf8'));
      if (spawnFailed) {
        reject(new VerifierInfrastructureError('verifier process could not start'));
        return;
      }
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
  // Core source is exercised by mirrored tests in the server workspace.
  const workspace = !test && file.startsWith('core/') ? 'server' : file.split('/')[0];
  if (!['server', 'webview-ui'].includes(workspace))
    throw new Error(
      `Unsupported Vitest ${test ? 'test ' : ''}root: ${JSON.stringify(file)}; expected server/ or webview-ui/`,
    );
  resolveInside(tree, file);
  return {
    root: resolveInside(tree, workspace),
    environment: 'node',
    globals: workspace === 'server',
    include: (workspace === 'server'
      ? testDiscovery(tree).server
      : testDiscovery(tree).webview
    ).map((pattern) => pattern.slice(workspace.length + 1)),
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
  onOutput?: (output: string) => void,
  prepared = false,
): Promise<{ result: 'pass' | 'fail'; passed: number; failed: number }> {
  vitestWorkspace(tree, file, true);
  return runWorkspaceVitest(
    tree,
    scratch,
    [file],
    false,
    timeoutMs,
    signal,
    testName,
    onOutput,
    prepared,
  );
}

export async function runRelatedVitest(
  tree: string,
  scratch: string,
  files: string[],
  timeoutMs: number,
  signal: AbortSignal,
  onOutput?: (output: string) => void,
) {
  return runWorkspaceVitest(tree, scratch, files, true, timeoutMs, signal, undefined, onOutput);
}

async function runWorkspaceVitest(
  tree: string,
  scratch: string,
  files: string[],
  related: boolean,
  timeoutMs: number,
  signal?: AbortSignal,
  testName?: string,
  onOutput?: (output: string) => void,
  prepared = false,
): Promise<{ result: 'pass' | 'fail'; passed: number; failed: number }> {
  let workspace = vitestWorkspace(tree, files[0]);
  if (files.some((file) => vitestWorkspace(tree, file).root !== workspace.root))
    throw new Error('Vitest command must use a single workspace');
  const temporary = fs.mkdtempSync(path.join(scratch, 'criterion-'));
  const deadline = Date.now() + timeoutMs;
  const dependencies = path.dirname(path.dirname(require.resolve('vitest/package.json')));
  let link: string | undefined;
  const home = resolveInside(temporary, 'home');
  fs.mkdirSync(home);
  let safeToCleanup = true;
  try {
    // SoftwareAgents server tests may use built hooks indirectly through imported modules.
    // Build every server invocation when this repository provides the fixed build entry.
    // Source-only repositories without esbuild.js retain the neutral Vitest profile.
    if (
      !prepared &&
      workspace.root === resolveInside(tree, 'server') &&
      fs.existsSync(path.join(tree, 'esbuild.js'))
    ) {
      const snapshot = resolveInside(temporary, 'project');
      const relativeScratch = path.relative(tree, scratch);
      const excludedScratch =
        relativeScratch && !relativeScratch.startsWith('..') && !path.isAbsolute(relativeScratch)
          ? path.join(tree, relativeScratch.split(path.sep)[0])
          : undefined;
      fs.mkdirSync(snapshot);
      // Copy entries so fs.cp also supports a scratch directory inside the source.
      // Its root-level source/destination overlap check runs before the filter.
      for (const entry of fs.readdirSync(tree))
        fs.cpSync(path.join(tree, entry), path.join(snapshot, entry), {
          recursive: true,
          filter: (source) =>
            source !== excludedScratch &&
            !['.git', 'node_modules', 'dist'].includes(path.basename(source)),
        });
      const dependencyLink = path.join(snapshot, 'node_modules');
      fs.symlinkSync(
        dependencies,
        dependencyLink,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      link = dependencyLink;
      const built = await runVerifierCommand(
        [process.execPath, 'esbuild.js'],
        snapshot,
        home,
        Math.max(1, deadline - Date.now()),
        signal,
        onOutput,
      );
      if (built !== 'pass' || signal?.aborted)
        throw new VerifierInfrastructureError('server build failed or timed out in scratch');
      tree = snapshot;
      workspace = vitestWorkspace(tree, files[0]);
    }
    const setup = resolveInside(temporary, 'isolated-home.mjs');
    fs.writeFileSync(
      setup,
      `import { expect, vi } from 'vitest';
vi.mock('os', async (original) => ({ ...(await original()), homedir: () => process.env.HOME }));
// Count executed node:assert calls in Vitest's own per-test state. Keep constructors
// and Function utilities intact; merely importing or reading an assertion never counts.
const instrumentAssert = vi.hoisted(() => (module, count) => {
  const proxies = new WeakMap();
  const wrap = (value) => {
    if (typeof value !== 'function') return value;
    if (proxies.has(value)) return proxies.get(value);
    const proxy = new Proxy(value, {
      apply(target, receiver, args) {
        count();
        return Reflect.apply(target, receiver, args);
      },
      get(target, key, receiver) {
        const member = Reflect.get(target, key, receiver);
        return Object.hasOwn(target, key) && !['AssertionError', 'CallTracker'].includes(key)
          ? wrap(member) : member;
      },
    });
    proxies.set(value, proxy);
    return proxy;
  };
  return Object.fromEntries(Object.entries(module).map(([key, value]) =>
    [key, ['AssertionError', 'CallTracker'].includes(key) ? value : wrap(value)]));
});
vi.mock('node:assert', async (original) => instrumentAssert(await original(), () => {
  expect.setState({ assertionCalls: expect.getState().assertionCalls + 1 });
}));
vi.mock('node:assert/strict', async (original) => instrumentAssert(await original(), () => {
  expect.setState({ assertionCalls: expect.getState().assertionCalls + 1 });
}));
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
    if (Date.now() >= deadline)
      throw new VerifierInfrastructureError('Vitest deadline exhausted during preparation');
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
      deadline - Date.now(),
      signal,
      onOutput,
    );
    if (
      passed === 'timeout' ||
      signal?.aborted ||
      !fs.existsSync(report) ||
      fs.statSync(report).size > EVAL_CRITERION_MAX_OUTPUT_BYTES
    )
      throw new VerifierInfrastructureError('Vitest timeout or missing/oversized JSON report');
    const result = JSON.parse(fs.readFileSync(report, 'utf8'));
    onOutput?.(
      result.testResults
        ?.flatMap(
          (suite: {
            name: string;
            message?: string;
            assertionResults?: { status: string; fullName: string; failureMessages?: string[] }[];
          }) => [
            ...(suite.message ? [suite.name, suite.message] : []),
            ...(suite.assertionResults ?? [])
              .filter((test) => test.status === 'failed')
              .flatMap((test) => [test.fullName, ...(test.failureMessages ?? [])]),
          ],
        )
        .join('\n') ?? '',
    );
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
      throw new VerifierInfrastructureError('Vitest missing, skipped or incomplete tests');
    const counts = {
      passed: assertions.filter((test: { status: string }) => test.status === 'passed').length,
      failed: assertions.filter((test: { status: string }) => test.status === 'failed').length,
    };
    if (
      (!related && !counts.passed && !counts.failed) ||
      (!counts.failed && (passed !== 'pass' || result.success !== true))
    )
      throw new VerifierInfrastructureError('Vitest failed without assertion failures');
    return { result: counts.failed ? 'fail' : 'pass', ...counts };
  } catch (error) {
    if (error instanceof EvalCriterionTerminationError) safeToCleanup = false;
    if (
      error instanceof EvalCriterionTerminationError ||
      error instanceof EvalIntegrityError ||
      error instanceof VerifierInfrastructureError
    )
      throw error;
    throw new VerifierInfrastructureError(
      'Vitest environment preparation or execution evidence unavailable',
    );
  } finally {
    if (safeToCleanup) {
      if (link) {
        if (
          !fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() ||
          fs.realpathSync.native(link) !== fs.realpathSync.native(dependencies)
        )
          throw new EvalIntegrityError('Vitest dependency link changed; scratch retained');
        fs.unlinkSync(link);
      }
      fs.rmSync(resolveInside(scratch, path.basename(temporary)), { recursive: true, force: true });
    }
  }
}
