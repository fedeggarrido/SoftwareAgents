import * as fs from 'fs';
import * as path from 'path';

import { evalGit, type EvalTask, isProtectedEvalPath } from './evalTasks.js';
import { DEFAULT_PROTECTED_PATHS, matchesProtectedPath } from './executors/protectedPaths.js';

export class EvalIntegrityError extends Error {
  constructor(message: string) {
    super(`criteria_tampered: ${message}`);
    this.name = 'EvalIntegrityError';
  }
}

/** Includes staged-only, deleted, untracked and ignored files. Never supplied by a Task. */
export function evalChangedFiles(tree: string, base: string): string[] {
  return [
    ...new Set(
      [
        ...evalGit(tree, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--name-only',
          '-z',
          base,
          '--',
        ]).split('\0'),
        ...evalGit(tree, [
          'diff',
          '--cached',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--name-only',
          '-z',
          base,
          '--',
        ]).split('\0'),
        ...evalGit(tree, ['ls-files', '--others', '-z']).split('\0'),
      ].filter(Boolean),
    ),
  ];
}

/** Fail before restoring verifiers or linking dependencies, including ignored/untracked files.
 * This is a cooperative-agent integrity check, not confinement against concurrent writers. */
export function assertEvalIntegrity(
  task: Pick<EvalTask, 'baseCommit'> & {
    allowedPaths?: string[];
    protectedPaths?: readonly string[];
  },
  tree: string,
): void {
  if (fs.lstatSync(tree).isSymbolicLink()) throw new EvalIntegrityError('Linked eval root');
  if (evalGit(tree, ['rev-parse', 'HEAD']) !== task.baseCommit)
    throw new EvalIntegrityError('Eval HEAD changed');
  // These index flags hide worktree edits from diff; a normal checkout has only H entries.
  if (
    evalGit(tree, ['ls-files', '-v', '-z'])
      .split('\0')
      .some((entry) => entry && !entry.startsWith('H '))
  )
    throw new EvalIntegrityError('Eval index hides changes');
  const changed = evalChangedFiles(tree, task.baseCommit);
  const protectedPaths = [
    ...DEFAULT_PROTECTED_PATHS,
    '.softwareagents/**',
    '**/.git/**',
    '.git/**',
    ...(task.protectedPaths ?? []),
  ];
  for (const file of changed)
    if (
      (task.allowedPaths && !task.allowedPaths.includes(file)) ||
      isProtectedEvalPath(file) ||
      protectedPaths.some((pattern) => matchesProtectedPath(file, pattern))
    )
      throw new EvalIntegrityError('Eval modified a forbidden path');
  const inspect = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const child = path.join(dir, name);
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) throw new EvalIntegrityError('Eval contains a link');
      if (stat.isDirectory()) {
        if (name === '.git') throw new EvalIntegrityError('Unexpected Git directory in eval');
        inspect(child);
      } else if (!stat.isFile() || stat.nlink > 1)
        throw new EvalIntegrityError('Eval contains a special file');
    }
  };
  inspect(tree);
}
