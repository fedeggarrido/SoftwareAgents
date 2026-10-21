import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as criteria from '../src/evalCriteria.js';
import { checkCascadeCriteria } from '../src/modelCascade.js';
import { runTaskTest } from '../src/taskTestRunner.js';

vi.setConfig({ testTimeout: 90_000 });
let root: string;
let tree: string;
let scratch: string;
const file = 'e2e/tests/standalone/audit.spec.ts';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-runner-'));
  tree = path.join(root, 'tree');
  scratch = path.join(root, 'scratch');
  for (const key of ['HOME', 'USERPROFILE']) vi.stubEnv(key, root);
  fs.mkdirSync(path.join(tree, path.dirname(file)), { recursive: true });
  fs.mkdirSync(path.join(tree, 'webview-ui'));
  fs.mkdirSync(scratch);
  fs.writeFileSync(path.join(tree, file), '// fake spec; no browser or real CLI');
  fs.writeFileSync(path.join(tree, 'esbuild.js'), '// fake build');
  fs.writeFileSync(path.join(tree, 'webview-ui/package.json'), '{}');
  const browser = path.join(root, 'fake-browser');
  fs.writeFileSync(browser, '');
  vi.spyOn(
    (require('playwright') as typeof import('playwright')).chromium,
    'executablePath',
  ).mockReturnValue(browser);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Bounded Playwright runtime (fake commands)', () => {
  it('keeps e2e out of Vitest related while retaining explicit execution evidence in the cascade', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: tree, encoding: 'utf8', windowsHide: true }).trim();
    git('init', '-b', 'main', '--separate-git-dir', path.join(root, 'metadata'));
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
    const base = git('rev-parse', 'HEAD');
    const relative = 'e2e/tests/claude/audit.spec.ts';
    fs.mkdirSync(path.dirname(path.join(tree, relative)), { recursive: true });
    fs.writeFileSync(path.join(tree, relative), '// mocked Electron spec');
    expect(
      await checkCascadeCriteria(
        { commands: [{ vitestRelated: true, timeoutMs: 10_000 }] },
        base,
        tree,
        scratch,
        new AbortController().signal,
        undefined,
        [relative],
      ),
    ).toEqual(['pass', 'not_tested']);
    expect(fs.existsSync(path.join(tree, 'node_modules'))).toBe(false);
  });
  it.each(['passed', 'failed', 'unasserted', 'skipped', 'missing', 'foreign', 'timeout'])(
    'accepts only complete executed evidence: %s',
    async (mode) => {
      const command = vi
        .spyOn(criteria, 'runVerifierCommand')
        .mockImplementation(async (argv, cwd, home, timeout, signal) => {
          expect(home.startsWith(scratch + path.sep)).toBe(true);
          expect(timeout).toBeGreaterThan(0);
          expect(timeout).toBeLessThanOrEqual(10_000);
          expect(signal).toBeInstanceOf(AbortSignal);
          expect(cwd.startsWith(scratch + path.sep)).toBe(true);
          if (!argv.includes('--config')) return 'pass';
          expect(argv.at(-1)).toBe('--workers=1');
          const config = require(argv[argv.indexOf('--config') + 1]);
          expect(config).toMatchObject({
            workers: 1,
            retries: 0,
            forbidOnly: true,
          });
          expect(config.testMatch.test(path.join(config.testDir, file))).toBe(true);
          expect(config.testMatch.test(path.join(config.testDir, 'other.spec.ts'))).toBe(false);
          expect(config.globalSetup).toBeUndefined();
          expect(config.reporter).toHaveLength(1);
          expect(fs.readFileSync(path.join(config.testDir, file), 'utf8')).toContain('fake spec');
          if (mode === 'timeout') return 'timeout';
          if (mode === 'missing') return 'fail';
          const Reporter = require(config.reporter[0][0]);
          const reporter = new Reporter();
          reporter.onBegin();
          const testCase = {
            id: 'fake-test',
            location: {
              file: path.join(config.testDir, mode === 'foreign' ? 'other.spec.ts' : file),
            },
          };
          if (mode !== 'unasserted') reporter.onStepEnd(testCase, {}, { category: 'expect' });
          reporter.onTestEnd(testCase, {
            status: ['foreign', 'unasserted'].includes(mode) ? 'passed' : mode,
          });
          reporter.onEnd({ status: mode === 'failed' ? 'failed' : 'passed' });
          return mode === 'failed' ? 'fail' : 'pass';
        });
      const result = await runTaskTest(tree, scratch, file, new AbortController().signal, 10_000);
      expect(command).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject(
        mode === 'passed'
          ? { result: 'pass', passed: 1, failed: 0 }
          : ['failed', 'unasserted'].includes(mode)
            ? { result: 'fail', passed: 0, failed: 1 }
            : { result: 'not_tested', reason: expect.any(String) },
      );
      expect(fs.readdirSync(scratch)).toEqual([]);
      expect(fs.existsSync(path.join(tree, 'node_modules'))).toBe(false);
      expect(fs.readFileSync(path.join(tree, file), 'utf8')).toBe(
        '// fake spec; no browser or real CLI',
      );
    },
  );

  it('retains scratch and its dependency link when process termination is unconfirmed', async () => {
    vi.spyOn(criteria, 'runVerifierCommand').mockRejectedValue(
      new criteria.EvalCriterionTerminationError(),
    );
    await expect(
      runTaskTest(tree, scratch, file, new AbortController().signal),
    ).rejects.toBeInstanceOf(criteria.EvalCriterionTerminationError);
    const retained = fs.readdirSync(scratch);
    expect(retained).toHaveLength(1);
    const link = path.join(scratch, retained[0], 'project/node_modules');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    // Test owns the fake process, which never spawned; unlink only this fixture link.
    fs.unlinkSync(link);
  });

  it('does not run commands or download anything for unavailable Electron/browser environments', async () => {
    const command = vi.spyOn(criteria, 'runVerifierCommand');
    expect(
      await runTaskTest(
        tree,
        scratch,
        'e2e/tests/claude/audit.spec.ts',
        new AbortController().signal,
      ),
    ).toMatchObject({ result: 'not_tested', reason: expect.stringContaining('Electron') });
    vi.mocked(
      (require('playwright') as typeof import('playwright')).chromium.executablePath,
    ).mockReturnValue(path.join(root, 'missing-browser'));
    expect(await runTaskTest(tree, scratch, file, new AbortController().signal)).toMatchObject({
      result: 'not_tested',
      reason: expect.stringContaining('Chromium'),
    });
    expect(command).not.toHaveBeenCalled();
  });
});
