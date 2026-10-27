import * as fs from 'fs';
import * as path from 'path';

import type { CascadeVerifier, ModelTier, ModelTierPolicy } from '../../core/src/modelTier.js';
import type { ProjectOperatorConfig } from '../../core/src/project.js';
import { EVAL_CRITERION_TIMEOUT_MS } from './constants.js';
import { developerStyleCommands } from './developer.js';
import {
  type CriterionResult,
  EvalCriterionTerminationError,
  runRelatedVitest,
  runVerifierCommand,
  vitestWorkspace,
} from './evalCriteria.js';
import { assertEvalIntegrity, evalChangedFiles, EvalIntegrityError } from './evalIntegrity.js';
import { evalGit } from './evalTasks.js';
import { MODEL_TIERS } from './modelTiers.js';
import { resolveInside } from './pathGuard.js';
import { runTaskTest, validateTaskTest } from './taskTestRunner.js';
import { addTelemetryTotals, emptyTelemetryTotals } from './telemetryCommand.js';
import { type VerifierFailure, verifierFailure, verifierKind } from './verifierFeedback.js';
import { VerifierInfrastructureError } from './verifierInfrastructure.js';

export interface CascadeAttempt {
  attempt: number;
  escalatedFrom?: ModelTier;
  tier: ModelTier;
  executor: string;
  model: string;
  verifiers: CriterionResult[];
  result: 'pass' | 'fail' | 'executor_error' | 'criteria_tampered' | 'infrastructure_error';
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
  feedback?: {
    failures: VerifierFailure[];
    autoFix?: () => void;
  },
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
  // Freeze task paths before our temporary dependency junction exists. Git's
  // untracked enumeration can otherwise walk that junction in disposable repos.
  const changedFiles = evalChangedFiles(tree, base);
  const fixCommands = feedback?.autoFix ? developerStyleCommands(tree, base, true).reverse() : [];
  const normalizedRoot = normalize(path.resolve(tree));
  const related = changedFiles
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
  for (const file of developerTests ?? []) validateTaskTest(tree, file);
  const relatedGroups = new Map<string, string[]>();
  if (verifier.commands.some((command) => 'vitestRelated' in command))
    for (const absolute of related) {
      const file = path.relative(tree, absolute).replaceAll('\\', '/');
      // Authored e2e specs use the explicit Playwright runner below, never Vitest related.
      if (developerTests && file.startsWith('e2e/')) continue;
      const { root } = vitestWorkspace(tree, file);
      relatedGroups.set(root, [...(relatedGroups.get(root) ?? []), file]);
    }
  const link = resolveInside(tree, 'node_modules');
  const dependencies = path.dirname(path.dirname(require.resolve('vitest/package.json')));
  fs.symlinkSync(dependencies, link, process.platform === 'win32' ? 'junction' : 'dir');
  let linked = true;
  const unlinkDependencies = () => {
    const stat = fs.lstatSync(link, { throwIfNoEntry: false });
    if (
      !stat?.isSymbolicLink() ||
      fs.realpathSync.native(link) !== fs.realpathSync.native(dependencies)
    )
      throw new EvalIntegrityError('Cascade dependency link changed');
    fs.unlinkSync(link);
    linked = false;
  };
  const temporary = fs.mkdtempSync(path.join(scratch, 'cascade-'));
  let safe = true;
  try {
    const results: CriterionResult[] = [];
    if (feedback?.autoFix) {
      // The caller has validated all changed paths against the task's zones. ESLint
      // may reorder imports; format its result before running any final verifier.
      for (const command of fixCommands) {
        if (signal.aborted) throw new Error('Cascade interrupted');
        if (!('argv' in command)) continue;
        const home = fs.mkdtempSync(path.join(temporary, 'fix-'));
        await runVerifierCommand(command.argv, tree, home, command.timeoutMs, signal);
      }
      // Integrity/zone guards inspect every link; remove only ours while checking.
      unlinkDependencies();
      feedback.autoFix();
      assertEvalIntegrity(integrity, tree, 'during');
      fs.symlinkSync(dependencies, link, process.platform === 'win32' ? 'junction' : 'dir');
      linked = true;
    }
    const report = (
      kind: VerifierFailure['verifier'],
      argv: string[],
      files: string[],
      result: CriterionResult,
      output: string,
    ) => {
      if (result === 'pass' || result === 'not_tested') return;
      feedback?.failures.push(
        verifierFailure(kind, argv, files, result, output, [
          tree,
          scratch,
          process.env.HOME ?? '',
          process.env.USERPROFILE ?? '',
        ]),
      );
    };
    const commands = developerTests
      ? [...verifier.commands, { developerTests, timeoutMs: EVAL_CRITERION_TIMEOUT_MS }]
      : verifier.commands;
    for (const command of commands) {
      if (signal.aborted) throw new Error('Cascade interrupted');
      if ('argv' in command) {
        const home = fs.mkdtempSync(path.join(temporary, 'home-'));
        let output = '';
        const result = await runVerifierCommand(
          command.argv,
          tree,
          home,
          command.timeoutMs,
          signal,
          (value) => {
            output = value;
          },
        );
        if (result === 'timeout') throw new VerifierInfrastructureError('command timed out');
        results.push(result);
        const files = command.argv.includes('--')
          ? command.argv.slice(command.argv.indexOf('--') + 1)
          : changedFiles;
        report(verifierKind(command.argv), command.argv, files, result, output);
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
            report(
              file.startsWith('e2e/') ? 'e2e' : 'tests',
              ['test', file],
              [file],
              'timeout',
              'Verifier batch deadline exceeded.',
            );
            break;
          }
          let output = '';
          try {
            const result = (
              await runTaskTest(tree, temporary, file, signal, remaining, (value) => {
                output = value;
              })
            ).result;
            if (result === 'not_tested' && !file.startsWith('e2e/'))
              throw new VerifierInfrastructureError('Vitest execution unavailable');
            checks.push(result);
            report(
              file.startsWith('e2e/') ? 'e2e' : 'tests',
              [file.startsWith('e2e/') ? 'playwright' : 'vitest', 'run', file],
              [file],
              result,
              output,
            );
          } catch (error) {
            if (
              error instanceof EvalCriterionTerminationError ||
              error instanceof VerifierInfrastructureError
            )
              throw error;
            checks.push('fail');
            report(
              file.startsWith('e2e/') ? 'e2e' : 'tests',
              ['test', file],
              [file],
              'fail',
              `${String(error)}\n${output}`,
            );
          }
        }
      } else {
        for (const files of relatedGroups.values()) {
          if (signal.aborted) throw new Error('Cascade interrupted');
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            checks.push('timeout');
            report(
              'tests',
              ['vitest', 'related', ...files],
              files,
              'timeout',
              'Verifier batch deadline exceeded.',
            );
            break;
          }
          let output = '';
          try {
            const result = (
              await runRelatedVitest(tree, temporary, files, remaining, signal, (value) => {
                output = value;
              })
            ).result;
            checks.push(result);
            report('tests', ['vitest', 'related', ...files], files, result, output);
          } catch (error) {
            if (
              error instanceof EvalCriterionTerminationError ||
              error instanceof VerifierInfrastructureError
            )
              throw error;
            checks.push('fail');
            report(
              'tests',
              ['vitest', 'related', ...files],
              files,
              'fail',
              `${String(error)}\n${output}`,
            );
          }
        }
      }
      const result = checks.includes('timeout')
        ? 'timeout'
        : checks.includes('fail')
          ? 'fail'
          : checks.includes('not_tested')
            ? 'not_tested'
            : checks.every((check) => check === 'pass') &&
                (!('developerTests' in command) || checks.length > 0)
              ? 'pass'
              : 'fail';
      if (result === 'timeout') throw new VerifierInfrastructureError('test batch timed out');
      results.push(result);
    }
    return results;
  } catch (error) {
    if (error instanceof EvalCriterionTerminationError) safe = false;
    throw error;
  } finally {
    if (safe) {
      // Unlink only our junction, never recursively delete its target.
      if (linked) unlinkDependencies();
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
