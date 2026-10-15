import * as fs from 'fs';
import * as path from 'path';

import type { CascadeVerifier, ModelTier, ModelTierPolicy } from '../../core/src/modelTier.js';
import type { ProjectOperatorConfig } from '../../core/src/project.js';
import {
  type CriterionResult,
  EvalCriterionTerminationError,
  runVerifierCommand,
} from './evalCriteria.js';
import { assertEvalIntegrity, evalChangedFiles, EvalIntegrityError } from './evalIntegrity.js';
import { evalGit } from './evalTasks.js';
import { MODEL_TIERS } from './modelTiers.js';
import { resolveInside } from './pathGuard.js';
import { addTelemetryTotals, emptyTelemetryTotals } from './telemetryCommand.js';

export interface CascadeAttempt {
  attempt: number;
  escalatedFrom?: ModelTier;
  tier: ModelTier;
  executor: string;
  model: string;
  verifiers: CriterionResult[];
  result: 'pass' | 'fail' | 'executor_error' | 'criteria_tampered';
  usage: {
    input: number | 'unknown';
    output: number | 'unknown';
    cacheRead: number | 'unknown';
    cacheCreate: number | 'unknown';
    costUsd: number | 'unknown';
  };
}

/** Only level restrictions skip a tier. Missing/disabled/unproven CLIs still wait via SA-090. */
export function cascadeLevels(
  policy: ModelTierPolicy,
  operator: ProjectOperatorConfig,
): ModelTier[] {
  const config = policy.cascade!;
  const levels = MODEL_TIERS.slice(
    MODEL_TIERS.indexOf(config.startTier),
    MODEL_TIERS.indexOf(policy.maxTier) + 1,
  ).filter((tier) => {
    const candidates = policy.tiers[tier]?.candidates;
    if (!candidates) return false;
    const allowed = candidates.filter((c) => operator.allowedExecutors.includes(c.executor));
    return (
      !allowed.length ||
      allowed.some((c) => operator.executorLevels?.[c.executor]?.includes(tier) ?? true)
    );
  });
  return levels.length ? levels.slice(0, config.maxEscalations + 1) : [config.startTier];
}

export function cascadeUsage(
  attributes: Parameters<typeof addTelemetryTotals>[1],
  operator: ProjectOperatorConfig,
): CascadeAttempt['usage'] {
  const totals = emptyTelemetryTotals();
  addTelemetryTotals(totals, attributes, operator.telemetry?.prices);
  return {
    input: totals.inputTokens,
    output: totals.outputTokens,
    cacheRead: totals.cacheReadTokens,
    cacheCreate: totals.cacheCreateTokens,
    costUsd: totals.costUsd,
  };
}

/** Same SA-QA-20 integrity and command isolation as evals, before any repository code runs.
 * Commands must use no-emit / external cache options; changes outside allowedPaths fail closed. */
export async function checkCascadeCriteria(
  verifier: CascadeVerifier,
  base: string,
  tree: string,
  scratch: string,
  signal: AbortSignal,
  protectedPaths?: readonly string[],
): Promise<CriterionResult[]> {
  const integrity = { baseCommit: base, allowedPaths: verifier.allowedPaths, protectedPaths };
  assertEvalIntegrity(integrity, tree);
  const related = evalChangedFiles(tree, base)
    .filter((file) => /\.[cm]?[jt]sx?$/i.test(file))
    .map((file) => path.resolve(tree, file).replace(/\\/g, '/'));
  const link = resolveInside(tree, 'node_modules');
  const dependencies = path.dirname(path.dirname(require.resolve('vitest/package.json')));
  fs.symlinkSync(dependencies, link, process.platform === 'win32' ? 'junction' : 'dir');
  const temporary = fs.mkdtempSync(path.join(scratch, 'cascade-'));
  let safe = true;
  try {
    const results: CriterionResult[] = [];
    for (const command of verifier.commands) {
      if (signal.aborted) throw new Error('Cascade interrupted');
      if ('vitestRelated' in command && !related.length) {
        results.push('pass');
        continue;
      }
      const home = fs.mkdtempSync(path.join(temporary, 'home-'));
      let argv: string[];
      if ('argv' in command) argv = command.argv;
      else {
        // Neutral external config avoids repo plugins/reporters/caches. os.homedir on
        // Windows ignores HOME, so isolate it inside the test workers as evals do.
        const setup = path.join(home, 'isolated-home.mjs');
        fs.writeFileSync(
          setup,
          `import { vi } from 'vitest';
vi.mock('os', async (original) => ({ ...(await original()), homedir: () => process.env.HOME }));
`,
        );
        const config = path.join(home, 'vitest.config.mjs');
        fs.writeFileSync(
          config,
          `export default ${JSON.stringify({
            cacheDir: path.join(home, 'cache'),
            test: {
              globals: true,
              setupFiles: [setup],
              pool: 'threads',
              maxWorkers: 1,
              testTimeout: command.timeoutMs / 2,
            },
          })};`,
        );
        argv = [
          process.execPath,
          path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
          'related',
          '--run',
          '--passWithNoTests',
          '--no-cache',
          '--root',
          tree,
          '--config',
          config,
          '--configLoader',
          'native',
          ...related,
        ];
      }
      results.push(await runVerifierCommand(argv, tree, home, command.timeoutMs, signal));
    }
    return results;
  } catch (error) {
    if (error instanceof EvalCriterionTerminationError) safe = false;
    throw error;
  } finally {
    if (safe) {
      // Unlink only our junction, never recursively delete its target.
      const stat = fs.lstatSync(link, { throwIfNoEntry: false });
      if (
        !stat?.isSymbolicLink() ||
        fs.realpathSync.native(link) !== fs.realpathSync.native(dependencies)
      )
        throw new EvalIntegrityError('Cascade dependency link changed');
      fs.unlinkSync(link);
      fs.rmSync(temporary, { recursive: true, force: true });
      assertEvalIntegrity(integrity, tree);
    }
  }
}

/** Caller holds the Task lock and has confirmed the executor and verifiers closed.
 * Integrity rejects junctions/special files before Git is allowed to discard anything. */
export function resetCascadeWorktree(
  verifier: CascadeVerifier,
  tree: string,
  base: string,
  protectedPaths?: readonly string[],
): void {
  assertEvalIntegrity(
    { baseCommit: base, allowedPaths: verifier.allowedPaths, protectedPaths },
    tree,
  );
  evalGit(tree, ['reset', '--hard', base]);
  evalGit(tree, ['clean', '-fdx']);
  if (evalGit(tree, ['status', '--porcelain', '--untracked-files=all']))
    throw new Error('Cascade reset left changes');
}
