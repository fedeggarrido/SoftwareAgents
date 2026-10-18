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
    /** Trusted Developer ingress only. Evals continue pinning tests. */
    allowTestChanges?: boolean;
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
  // Git reports a submodule as a single gitlink, hiding its protected descendants.
  // Check both views: staged-only changes can disappear from the worktree diff.
  for (const staged of [false, true]) {
    const entries = evalGit(tree, [
      'diff',
      ...(staged ? ['--cached'] : []),
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--ignore-submodules=none',
      '--raw',
      '-z',
      task.baseCommit,
      '--',
    ]).split('\0');
    for (let i = 0; i < entries.length - 1; i += 2) {
      const [before, after] = entries[i].slice(1).split(' ');
      if (before === '160000' || after === '160000')
        throw new EvalIntegrityError('Eval changed a Git submodule');
    }
  }
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
      // Vitest's path normalization (pathe) treats backslashes as separators even on POSIX.
      (process.platform !== 'win32' && file.includes('\\')) ||
      (task.allowedPaths && !task.allowedPaths.includes(file)) ||
      isProtectedEvalPath(file, task.allowTestChanges) ||
      protectedPaths.some((pattern) => matchesProtectedPath(file, pattern))
    )
      throw new EvalIntegrityError('Eval modified a forbidden path');
  const inspect = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === '.git' && dir !== tree)
        throw new EvalIntegrityError('Unexpected nested .git in eval');
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
