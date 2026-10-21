import * as fs from 'fs';
import * as path from 'path';

import type { CascadeVerifier, ModelTier, ModelTierPolicy } from '../../core/src/modelTier.js';
import type { ProjectOperatorConfig } from '../../core/src/project.js';
import { EVAL_CRITERION_TIMEOUT_MS } from './constants.js';
import {
  type CriterionResult,
  EvalCriterionTerminationError,
  runIsolatedVitest,
  runRelatedVitest,
  runVerifierCommand,
  vitestWorkspace,
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

// Vitest normalizes with pathe: backslashes are separators, then POSIX normalization.
// Backslash names are already rejected on POSIX, so this matches it without a dependency.
const normalize = (value: string): string => path.posix.normalize(value.replace(/\\/g, '/'));
const relative = (from: string, to: string): string => path.posix.relative(from, to);
const isAbsolute = (value: string): boolean =>
  path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value);

/** Same SA-QA-20 integrity and command isolation as evals, before any repository code runs.
 * Commands must use no-emit / external cache options; changes outside allowedPaths fail closed. */
export async function checkCascadeCriteria(
  verifier: CascadeVerifier,
  base: string,
  tree: string,
  scratch: string,
  signal: AbortSignal,
  protectedPaths?: readonly string[],
  developerTests?: string[],
  expectedHead = base,
): Promise<CriterionResult[]> {
  const integrity = {
    baseCommit: base,
    expectedHead,
    allowedPaths:
      verifier.allowedPaths && developerTests
        ? [...verifier.allowedPaths, ...developerTests]
        : verifier.allowedPaths,
    protectedPaths,
    allowTestChanges: !!developerTests,
  };
  assertEvalIntegrity(integrity, tree);
  const normalizedRoot = normalize(path.resolve(tree));
  const related = evalChangedFiles(tree, base)
    .filter((file) => /\.[cm]?[jt]sx?$/i.test(file))
    .map((file) => {
      // Validate the exact normalization Vitest applies, including deleted paths.
      const normalized = normalize(path.resolve(tree, file));
      const descendant = relative(normalizedRoot, normalized);
      if (
        !descendant ||
        descendant === '..' ||
        descendant.startsWith('../') ||
        isAbsolute(descendant)
      )
        throw new EvalIntegrityError('Related test path escaped the eval tree');
      return normalized;
    });
  // Resolve all roots before linking dependencies or executing a verifier.
  for (const file of developerTests ?? []) vitestWorkspace(tree, file, true);
  const relatedGroups = new Map<string, string[]>();
  if (verifier.commands.some((command) => 'vitestRelated' in command))
    for (const absolute of related) {
      const file = path.relative(tree, absolute).replaceAll('\\', '/');
      const { root } = vitestWorkspace(tree, file);
      relatedGroups.set(root, [...(relatedGroups.get(root) ?? []), file]);
    }
  const link = resolveInside(tree, 'node_modules');
  const dependencies = path.dirname(path.dirname(require.resolve('vitest/package.json')));
  fs.symlinkSync(dependencies, link, process.platform === 'win32' ? 'junction' : 'dir');
  const temporary = fs.mkdtempSync(path.join(scratch, 'cascade-'));
  let safe = true;
  try {
    const results: CriterionResult[] = [];
    const commands = developerTests
      ? [...verifier.commands, { developerTests, timeoutMs: EVAL_CRITERION_TIMEOUT_MS }]
      : verifier.commands;
    for (const command of commands) {
      if (signal.aborted) throw new Error('Cascade interrupted');
      if ('argv' in command) {
        const home = fs.mkdtempSync(path.join(temporary, 'home-'));
        results.push(await runVerifierCommand(command.argv, tree, home, command.timeoutMs, signal));
        continue;
      }
      const checks: CriterionResult[] = [];
      const deadline = Date.now() + command.timeoutMs;
      if ('developerTests' in command) {
        for (const file of command.developerTests) {
          if (signal.aborted) throw new Error('Cascade interrupted');
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            checks.push('timeout');
            break;
          }
          try {
            checks.push(
              (await runIsolatedVitest(tree, temporary, file, undefined, signal, remaining)).result,
            );
          } catch (error) {
            if (error instanceof EvalCriterionTerminationError) throw error;
            checks.push('fail');
          }
        }
      } else {
        for (const files of relatedGroups.values()) {
          if (signal.aborted) throw new Error('Cascade interrupted');
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            checks.push('timeout');
            break;
          }
          try {
            checks.push((await runRelatedVitest(tree, temporary, files, remaining, signal)).result);
          } catch (error) {
            if (error instanceof EvalCriterionTerminationError) throw error;
            checks.push('fail');
          }
        }
      }
      const result = checks.includes('timeout')
        ? 'timeout'
        : checks.every((check) => check === 'pass') &&
            (!('developerTests' in command) || checks.length > 0)
          ? 'pass'
          : 'fail';
      results.push(result);
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
      assertEvalIntegrity(integrity, tree, 'during');
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
  developerTests?: string[],
  expectedHead = base,
): void {
  assertEvalIntegrity(
    {
      baseCommit: base,
      expectedHead,
      allowedPaths:
        verifier.allowedPaths && developerTests
          ? [...verifier.allowedPaths, ...developerTests]
          : verifier.allowedPaths,
      protectedPaths,
      allowTestChanges: !!developerTests,
    },
    tree,
  );
  evalGit(tree, ['reset', '--hard', expectedHead]);
  evalGit(tree, ['clean', '-fdx']);
  if (evalGit(tree, ['status', '--porcelain', '--untracked-files=all']))
    throw new Error('Cascade reset left changes');
}
