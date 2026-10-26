import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';

import type { TestReport } from '../../core/src/testReport.js';
import { EVAL_CRITERION_MAX_OUTPUT_BYTES, EVAL_CRITERION_TIMEOUT_MS } from './constants.js';
import {
  EvalCriterionTerminationError,
  runIsolatedVitest,
  runVerifierCommand,
  vitestWorkspace,
} from './evalCriteria.js';
import { EvalIntegrityError } from './evalIntegrity.js';
import { resolveInside } from './pathGuard.js';

type TestResult = Omit<TestReport['commands'][number], 'command'>;

export function isE2eTest(file: string): boolean {
  return file.startsWith('e2e/') && /\.(spec|test)\.[cm]?[jt]sx?$/i.test(file);
}

export function validateTaskTest(tree: string, file: string): void {
  if (isE2eTest(file)) resolveInside(tree, file);
  else vitestWorkspace(tree, file, true);
}

export function taskTestCommand(file: string): string {
  return (isE2eTest(file) ? 'playwright:' : 'vitest:') + file;
}

/** Same bounded, allowlisted subprocess runner as Vitest. No repository config/globalSetup,
 * downloads, npm scripts or model-supplied argv. Builds and browser artifacts stay in scratch. */
export async function runTaskTest(
  tree: string,
  scratch: string,
  file: string,
  signal: AbortSignal,
  timeoutMs = EVAL_CRITERION_TIMEOUT_MS,
  onOutput?: (output: string) => void,
): Promise<TestResult> {
  validateTaskTest(tree, file);
  if (!isE2eTest(file))
    return runIsolatedVitest(tree, scratch, file, undefined, signal, timeoutMs, onOutput);
  const unavailable = (reason: string): TestResult => ({
    result: 'not_tested',
    passed: 0,
    failed: 0,
    reason,
  });
  // Electron provisioning is deliberately outside the verifier; never download VS Code.
  if (!file.startsWith('e2e/tests/standalone/'))
    return unavailable(
      'Runtime supports standalone Playwright specs only; Electron/VS Code requires operator QA.',
    );
  let executablePath: string;
  let playwright: string;
  try {
    executablePath = (
      createRequire(__filename)('playwright') as typeof import('playwright')
    ).chromium.executablePath();
    playwright = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
  } catch {
    return unavailable('Playwright is unavailable; no dependencies were installed.');
  }
  if (!fs.existsSync(executablePath))
    return unavailable('Chromium is not cached; runtime never downloads browsers.');
  if (
    !fs.existsSync(path.join(tree, 'esbuild.js')) ||
    !fs.existsSync(path.join(tree, 'webview-ui/package.json'))
  )
    return unavailable('Standalone build inputs are unavailable in the task checkout.');
  const temporary = fs.mkdtempSync(path.join(scratch, 'playwright-'));
  const snapshot = path.join(temporary, 'project');
  const home = path.join(temporary, 'home');
  const link = path.join(snapshot, 'node_modules');
  const dependencies = path.dirname(path.dirname(require.resolve('vitest/package.json')));
  let safe = true;
  let linked = false;
  const deadline = Date.now() + timeoutMs;
  const run = (argv: string[], cwd: string) =>
    Date.now() >= deadline
      ? Promise.resolve('timeout' as const)
      : runVerifierCommand(argv, cwd, home, deadline - Date.now(), signal, onOutput);
  try {
    fs.mkdirSync(home);
    fs.cpSync(tree, snapshot, {
      recursive: true,
      filter: (source) => !['.git', 'node_modules'].includes(path.basename(source)),
    });
    fs.symlinkSync(dependencies, link, process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
    for (const [argv, cwd] of [
      [[process.execPath, 'esbuild.js'], snapshot],
      [
        [
          process.execPath,
          path.join(dependencies, 'vite/bin/vite.js'),
          // Default (bundle) config loader: vite.config.ts uses __dirname, which the
          // ESM `runner` loader does not define. The snapshot is a throwaway copy.
          'build',
        ],
        path.join(snapshot, 'webview-ui'),
      ],
    ] as [string[], string][]) {
      if ((await run(argv, cwd)) !== 'pass')
        return unavailable('Standalone build failed or timed out in the isolated runtime.');
    }
    const report = path.join(temporary, 'playwright.json');
    const config = path.join(temporary, 'playwright.config.cjs');
    // JSON goes to a dedicated runtime reporter; no stdout or repository reporters are trusted.
    const reporter = path.join(temporary, 'reporter.cjs');
    fs.writeFileSync(
      reporter,
      `module.exports = class {
  onBegin() { this.tests = []; this.assertions = new Set(); }
  onStepEnd(test, result, step) { if (step.category === 'expect') this.assertions.add(test.id); }
  onTestEnd(test, result) {
    const status = result.status === 'passed' && !this.assertions.has(test.id) ? 'unasserted' : result.status;
    this.tests.push({ file: test.location.file, status, errors: result.errors });
  }
  onEnd(result) { require('fs').writeFileSync(${JSON.stringify(report)}, JSON.stringify({ status: result.status, tests: this.tests })); }
};`,
    );
    fs.writeFileSync(
      config,
      `module.exports = { ...${JSON.stringify({
        testDir: snapshot,
        workers: 1,
        retries: 0,
        forbidOnly: true,
        timeout: timeoutMs / 2,
        globalTimeout: timeoutMs,
        reporter: [[reporter]],
        outputDir: path.join(temporary, 'artifacts'),
        use: { launchOptions: { executablePath } },
      })}, testMatch: new RegExp(${JSON.stringify('^' + path.resolve(snapshot, file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')}) };`,
    );
    const result = await run(
      [process.execPath, playwright, 'test', '--config', config, '--workers=1'],
      snapshot,
    );
    if (
      result === 'timeout' ||
      !fs.existsSync(report) ||
      fs.statSync(report).size > EVAL_CRITERION_MAX_OUTPUT_BYTES
    )
      return unavailable('Playwright timed out or produced no bounded execution report.');
    const evidence = JSON.parse(fs.readFileSync(report, 'utf8')) as {
      status: string;
      tests: { file: string; status: string; errors?: { message?: string; stack?: string }[] }[];
    };
    onOutput?.(
      evidence.tests
        .filter((test) => test.status !== 'passed')
        .flatMap((test) => [
          test.file,
          test.status,
          ...(test.errors ?? []).map((error) => error.message ?? error.stack ?? ''),
        ])
        .join('\n'),
    );
    const tests = evidence.tests;
    if (
      !Array.isArray(tests) ||
      !tests.length ||
      tests.some(
        (test) =>
          path.resolve(test.file) !== path.resolve(snapshot, file) ||
          !['passed', 'failed', 'timedOut', 'unasserted'].includes(test.status),
      )
    )
      return unavailable('Playwright returned missing, skipped or incomplete spec evidence.');
    const passed = tests.filter((test) => test.status === 'passed').length;
    const failed = tests.length - passed;
    if (!failed && (result !== 'pass' || evidence.status !== 'passed'))
      return unavailable('Playwright infrastructure failed without a test failure.');
    return { result: failed ? 'fail' : 'pass', passed, failed };
  } catch (error) {
    if (error instanceof EvalCriterionTerminationError) {
      safe = false;
      throw error;
    }
    return unavailable('Playwright runtime failed to prepare or read execution evidence.');
  } finally {
    if (safe) {
      if (linked) {
        if (
          !fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() ||
          fs.realpathSync.native(link) !== fs.realpathSync.native(dependencies)
        )
          throw new EvalIntegrityError('Playwright dependency link changed; scratch retained');
        fs.unlinkSync(link);
      }
      fs.rmSync(resolveInside(scratch, path.basename(temporary)), { recursive: true, force: true });
    }
  }
}
