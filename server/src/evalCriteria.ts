import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import { EVAL_CRITERION_TIMEOUT_MS } from './constants.js';
import { MANAGED_EXECUTION_ENV } from './evalGuard.js';
import { evalGit, type EvalTask } from './evalTasks.js';
import { resolveInside } from './pathGuard.js';

const execute = promisify(execFile);

/** Restore pinned tests AFTER the model stops. Never trust a repository test config.
 * Existing dependency trees are linked read-only by convention, never installed or cleaned. */
export async function checkEvalCriteria(
  task: EvalTask,
  repository: string,
  tree: string,
  scratch: string,
): Promise<boolean[]> {
  const dependencies = path.dirname(path.dirname(require.resolve('vitest/package.json')));
  const link = resolveInside(tree, 'node_modules');
  if (fs.existsSync(link)) throw new Error('Evaluation created node_modules; refusing to reuse it');
  fs.symlinkSync(dependencies, link, process.platform === 'win32' ? 'junction' : 'dir');
  const home = resolveInside(scratch, 'home');
  fs.mkdirSync(home, { recursive: true });
  const setup = resolveInside(scratch, 'isolated-home.mjs');
  fs.writeFileSync(
    setup,
    `import { vi } from 'vitest';
vi.mock('os', async (original) => ({ ...(await original()), homedir: () => process.env.HOME }));
`,
  );
  const config = resolveInside(scratch, 'vitest.config.mjs');
  const report = resolveInside(scratch, 'criteria.json');
  fs.writeFileSync(
    config,
    `export default ${JSON.stringify({
      cacheDir: resolveInside(scratch, 'cache'),
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
  // Restore every verifier before running any of them. An edited test cannot pass itself.
  for (const criterion of task.criteria) {
    const target = resolveInside(tree, criterion.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, evalGit(repository, ['show', `${task.fixCommit}:${criterion.file}`]));
  }
  const results: boolean[] = [];
  for (const criterion of task.criteria) {
    fs.rmSync(report, { force: true });
    try {
      await execute(
        process.execPath,
        [
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
        {
          cwd: tree,
          windowsHide: true,
          timeout: EVAL_CRITERION_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            CODEX_HOME: path.join(home, '.codex'),
            TEMP: scratch,
            TMP: scratch,
            [MANAGED_EXECUTION_ENV]: 'eval-criteria',
          },
        },
      );
      const result = JSON.parse(fs.readFileSync(report, 'utf8'));
      results.push(
        result.success === true && result.numPassedTests > 0 && result.numFailedTests === 0,
      );
    } catch {
      results.push(false);
    }
  }
  return results;
}
