import * as fs from 'fs';
import * as path from 'path';

import { evalGit, type EvalTask, isProtectedEvalPath } from './evalTasks.js';

/** Fail before restoring verifiers or linking dependencies, including ignored/untracked files.
 * This is a cooperative-agent integrity check, not confinement against concurrent writers. */
export function assertEvalIntegrity(task: EvalTask, tree: string): void {
  if (fs.lstatSync(tree).isSymbolicLink()) throw new Error('Linked eval root');
  if (evalGit(tree, ['rev-parse', 'HEAD']) !== task.baseCommit)
    throw new Error('Eval HEAD changed');
  // These index flags hide worktree edits from diff; a normal checkout has only H entries.
  if (
    evalGit(tree, ['ls-files', '-v', '-z'])
      .split('\0')
      .some((entry) => entry && !entry.startsWith('H '))
  )
    throw new Error('Eval index hides changes');
  const changed = [
    ...evalGit(tree, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--name-only',
      '-z',
      task.baseCommit,
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
      task.baseCommit,
      '--',
    ]).split('\0'),
    ...evalGit(tree, ['ls-files', '--others', '-z']).split('\0'),
  ].filter(Boolean);
  for (const file of changed)
    if (!task.allowedPaths.includes(file) || isProtectedEvalPath(file))
      throw new Error('Eval modified a forbidden path');
  const inspect = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const child = path.join(dir, name);
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) throw new Error('Eval contains a link');
      if (stat.isDirectory()) {
        if (name === '.git') throw new Error('Unexpected Git directory in eval');
        inspect(child);
      } else if (!stat.isFile() || stat.nlink > 1) throw new Error('Eval contains a special file');
    }
  };
  inspect(tree);
}
