import { execFileSync } from 'child_process';
import * as fs from 'fs';

import * as schema from '../../core/schemas/eval-task.schema.json';
import { CliUsageError } from './cliErrors.js';
import { resolveInside } from './pathGuard.js';
import { compileSchema, validateSchema } from './schemaValidation.js';

export interface EvalTask {
  version: 1;
  id: string;
  baseCommit: string;
  fixCommit: string;
  brief: string;
  timeoutMin: number;
  allowedPaths: string[];
  criteria: { file: string; testName: string }[];
}
const validate = compileSchema<EvalTask>(schema);
export function parseEvalTask(raw: unknown): EvalTask {
  const task = validateSchema(validate, raw);
  for (const file of task.allowedPaths) {
    if (isProtectedEvalPath(file))
      throw new CliUsageError(`${task.id}: allowedPaths cannot include tests or configuration`);
  }
  for (const criterion of task.criteria) {
    try {
      new RegExp(criterion.testName);
    } catch {
      throw new CliUsageError(`${task.id}: invalid criterion testName regular expression`);
    }
  }
  return task;
}

export function isProtectedEvalPath(file: string): boolean {
  return /(^|\/)(__tests__|__mocks__|tests?|node_modules)(\/|$)|(^|\/)[^/]*\.(test|spec)\.[^/]+$|(^|\/)(vitest|tsconfig|\.?eslint)[^/]*|(^|\/)package[^/]*\.json$|(^|\/)([^/]+\.lockb?|pnpm-lock\.yaml|npm-shrinkwrap\.json)$/i.test(
    file,
  );
}

export function evalGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Reads declarations and pinned verifiers only. No worktree, config writes or probes. */
export function loadEvalTasks(cwd: string): EvalTask[] {
  const dir = resolveInside(cwd, '.softwareagents/evals');
  if (!fs.existsSync(dir)) throw new CliUsageError('No .softwareagents/evals task bank');
  const tasks = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const task = parseEvalTask(JSON.parse(fs.readFileSync(resolveInside(dir, name), 'utf8')));
      if (name !== `${task.id}.json`) throw new CliUsageError('Eval filename must match task id');
      if (evalGit(cwd, ['rev-parse', `${task.fixCommit}^`]) !== task.baseCommit)
        throw new CliUsageError(`${task.id}: baseCommit must be the parent of fixCommit`);
      for (const criterion of task.criteria)
        evalGit(cwd, ['cat-file', '-e', `${task.fixCommit}:${criterion.file}`]);
      return task;
    });
  if (!tasks.length || new Set(tasks.map((task) => task.id)).size !== tasks.length)
    throw new CliUsageError('Eval bank must have unique tasks');
  return tasks;
}
