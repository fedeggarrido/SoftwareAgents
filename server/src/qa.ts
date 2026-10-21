import * as fs from 'fs';
import * as path from 'path';

import * as contract from '../../core/schemas/test-report.schema.json';
import type { TestReport } from '../../core/src/testReport.js';
import { matchesChangeZone } from './changeZones.js';
import { taskPath } from './commands/taskFiles.js';
import { QA_MAX_TEST_FILES, TASK_CLI_INPUT_BYTES } from './constants.js';
import { isDeveloperTest } from './developer.js';
import { EvalCriterionTerminationError, runIsolatedVitest } from './evalCriteria.js';
import { assertEvalIntegrity } from './evalIntegrity.js';
import { evalGit } from './evalTasks.js';
import { guardRequirementsWrites, requirementsSnapshot } from './requirements.js';
import type { ReviewerRequest } from './reviewer.js';
import { compileSchema, SchemaValidationError, validateSchema } from './schemaValidation.js';

const validateReport = compileSchema<TestReport>(contract);

/** Closed command set derived by the runtime, never shell/argv supplied by the model or Brain. */
export function qaTestFiles(input: ReviewerRequest): string[] {
  const files = evalGit(input.worktree, ['ls-files', '-z']).split('\0').filter(Boolean);
  const zones = [...(input.task.changeZones ?? []), ...(input.task.testZones ?? [])];
  const selected = files
    .filter((file) => {
      if (
        !isDeveloperTest(file) ||
        !['server/__tests__/', 'webview-ui/test/'].some((root) => file.startsWith(root))
      )
        return false;
      const source = file
        .replace(/\.(test|spec)(?=\.[cm]?[jt]sx?$)/i, '')
        .replace('server/__tests__/', 'server/src/');
      return (
        input.files.includes(file) ||
        zones.some((zone) => {
          const target = taskPath(input.worktree, zone.split('*')[0].replace(/\/$/, '') || '.');
          const directory =
            zone.endsWith('/') ||
            (!zone.includes('*') && fs.statSync(target, { throwIfNoEntry: false })?.isDirectory());
          return (
            matchesChangeZone(file, zone, !!directory) ||
            matchesChangeZone(source, zone, !!directory)
          );
        })
      );
    })
    .sort();
  if (!selected.length || selected.length > QA_MAX_TEST_FILES)
    throw new Error('QA requires a bounded set of task tests (1-' + QA_MAX_TEST_FILES + ')');
  for (const file of selected) taskPath(input.worktree, file);
  return selected;
}

/** Dependencies are linked only during runtime verification; agent remains read_only. */
export async function qaCommands(
  input: ReviewerRequest,
  scratch: string,
  signal: AbortSignal,
  requested?: string[],
): Promise<TestReport['commands']> {
  const tree = input.worktree;
  const integrity = {
    baseCommit: input.reviewRef.sha,
    expectedHead: input.reviewRef.sha,
    allowedPaths: [],
  };
  assertEvalIntegrity(integrity, tree);
  const before = requirementsSnapshot(tree);
  const allowed = qaTestFiles(input);
  const files = requested
    ? allowed.filter((file) => requested.includes('vitest:' + file))
    : allowed;
  if (requested && (!files.length || files.length !== requested.length))
    throw new Error('QA command outside runtime allowlist');
  const dependencies = path.dirname(path.dirname(require.resolve('vitest/package.json')));
  const link = path.join(tree, 'node_modules');
  if (fs.lstatSync(link, { throwIfNoEntry: false }))
    throw new Error('QA refuses existing dependency tree');
  fs.mkdirSync(scratch, { recursive: true });
  fs.symlinkSync(dependencies, link, process.platform === 'win32' ? 'junction' : 'dir');
  let safe = true;
  try {
    const results: TestReport['commands'] = [];
    for (const file of files) {
      if (signal.aborted) throw new Error('QA verifier interrupted');
      results.push({
        command: 'vitest:' + file,
        ...(await runIsolatedVitest(tree, scratch, file, undefined, signal)),
      });
    }
    return results;
  } catch (error) {
    if (error instanceof EvalCriterionTerminationError) safe = false;
    throw error;
  } finally {
    if (safe) {
      if (
        !fs.lstatSync(link).isSymbolicLink() ||
        fs.realpathSync.native(link) !== fs.realpathSync.native(dependencies)
      )
        throw new Error('QA dependency link changed');
      fs.unlinkSync(link);
      assertEvalIntegrity(integrity, tree, 'during');
      guardRequirementsWrites(tree, before);
    }
  }
}

export function qaBrief(
  input: ReviewerRequest,
  commands: TestReport['commands'],
  errors: string[] = [],
  requestsUsed = false,
): string {
  return JSON.stringify({
    ...input,
    contract,
    commands,
    commandAllowlist: requestsUsed ? [] : commands.map((c) => c.command),
    validationErrors: errors,
    instruction:
      'Attempt to break every assigned AC using reading and reasoning, including edge cases. Commands above were executed by the runtime. Do not execute commands or write files. Return the TestReport with exactly this command evidence. You may request one additional bounded batch to reproduce results, returning only {requestCommands: [command IDs from commandAllowlist]}; the runtime executes it. No shell or argv. Once the allowlist is empty return the final TestReport. An AC outside this task scope may be deferred only when deferredCoverage lists an unfinished downstream task for it; explain the reason in evidence. All other AC must pass for a pass verdict. Without downstream coverage an unverified AC is not_tested, including AC deferred by earlier tasks; never invent execution evidence.',
  });
}

/** Separate request envelope, never an executable command string from the agent. */
export function qaRequestedCommands(
  source: string,
  commands: TestReport['commands'],
  used: boolean,
): string[] | undefined {
  if (Buffer.byteLength(source) > TASK_CLI_INPUT_BYTES)
    throw new SchemaValidationError(['QA response exceeds 1 MiB']);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || !('requestCommands' in value)) return undefined;
  const rows = (value as { requestCommands: unknown }).requestCommands;
  if (
    used ||
    Object.keys(value).length !== 1 ||
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > QA_MAX_TEST_FILES ||
    new Set(rows).size !== rows.length ||
    rows.some((id) => typeof id !== 'string' || !commands.some((c) => c.command === id))
  )
    throw new SchemaValidationError([
      'Additional QA commands must belong to runtime allowlist; one batch only',
    ]);
  return rows as string[];
}

export function validateTestReport(
  source: string,
  input: ReviewerRequest,
  commands: TestReport['commands'],
): TestReport {
  if (Buffer.byteLength(source) > TASK_CLI_INPUT_BYTES)
    throw new SchemaValidationError(['TestReport exceeds 1 MiB']);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new SchemaValidationError(['QA must return a JSON object']);
  }
  const report = validateSchema(validateReport, value);
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const ac of report.acceptance) {
    if (!input.task.acceptanceRefs.includes(ac.ac) || seen.has(ac.ac))
      errors.push('Unknown/duplicate AC: ' + ac.ac);
    seen.add(ac.ac);
    if (ac.status === 'fail' && !report.defects.some((d) => d.ac === ac.ac))
      errors.push('Failed AC requires linked defect: ' + ac.ac);
  }
  if (seen.size !== input.task.acceptanceRefs.length)
    errors.push('TestReport must cover every assigned AC');
  for (const defect of report.defects)
    if (!report.acceptance.some((ac) => ac.ac === defect.ac && ac.status === 'fail'))
      errors.push('Defect requires a failed assigned AC');
  const proposedPass = report.verdict === 'pass';
  let downgraded = false;
  for (const ac of report.acceptance)
    if (ac.status === 'deferred' && !input.deferredCoverage?.[ac.ac]?.length) {
      ac.status = 'not_tested';
      downgraded = true;
    }
  const verdict = report.acceptance.some((ac) => ac.status === 'fail')
    ? 'fail'
    : report.acceptance.some((ac) => ac.status === 'not_tested')
      ? 'not_tested'
      : 'pass';
  if (downgraded && proposedPass && verdict === 'not_tested') report.verdict = verdict;
  else if (verdict !== report.verdict) errors.push('Contradictory verdict');
  if (proposedPass && (!commands.length || commands.some((c) => c.result !== 'pass')))
    errors.push('Cannot pass with missing/failed runtime commands');
  const evidence = (rows: TestReport['commands']) =>
    rows.map(({ command, result, passed, failed }) => ({ command, result, passed, failed }));
  if (JSON.stringify(evidence(report.commands)) !== JSON.stringify(evidence(commands)))
    errors.push('Commands must exactly match runtime evidence; model commands are forbidden');
  if (errors.length) throw new SchemaValidationError(errors);
  return report;
}
