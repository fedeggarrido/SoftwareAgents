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
          include: ['__tests__/**/*.test.ts'],
          setupFiles: [setup],
          globals: true,
          reporters: ['json'],
          outputFile: report,
          pool: 'threads',
          maxWorkers: 1,
          testTimeout: EVAL_CRITERION_TIMEOUT_MS / 2,
        },
      })};`,
    );
    let safeToCleanup = true;
    try {
      const passed = await runVerifierCommand(
        [
          process.execPath,
          path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
          'run',
          '--root',
          path.join(tree, 'server'),
          '--config',
          config,
          '--configLoader',
          'native',
          '--no-cache',
          criterion.file.slice('server/'.length),
          '--testNamePattern',
          criterion.testName,
        ],
        tree,
        home,
      );
      if (passed !== 'pass' || fs.statSync(report).size > EVAL_CRITERION_MAX_OUTPUT_BYTES) {
        results.push(false);
        continue;
      }
      const result = JSON.parse(fs.readFileSync(report, 'utf8'));
      results.push(
        result.success === true && result.numPassedTests > 0 && result.numFailedTests === 0,
      );
    } catch (error) {
      if (error instanceof EvalCriterionTerminationError) {
        safeToCleanup = false;
        throw error;
      }
      results.push(false);
    } finally {
      if (safeToCleanup) fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  return results;
}
