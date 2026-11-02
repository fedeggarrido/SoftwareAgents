import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import { evalGit } from './evalTasks.js';
import { withoutOperatorToken } from './featureIngress.js';
import { resolveInside } from './pathGuard.js';

const execute = promisify(execFile);

/** Never traverses links, including node_modules junctions created during a run. */
function unlinkTreeLinks(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    const child = path.join(dir, name);
    const stat = fs.lstatSync(child);
    if (stat.isSymbolicLink()) fs.unlinkSync(child);
    else if (stat.isDirectory()) unlinkTreeLinks(child);
  }
}

export async function createEvalWorktree(cwd: string, common: string, base: string) {
  // Git common dir belongs to the main checkout, even when invoked in a worktree.
  const main = evalGit(cwd, ['worktree', 'list', '--porcelain', '-z']).split('\0')[0].slice(9);
  const tree = resolveInside(main, `.worktrees/eval-${randomUUID()}`);
  const script = path.resolve(cwd, 'scripts/remove-worktree.ps1');
  if (process.platform === 'win32' && !fs.existsSync(script))
    throw new Error('Safe worktree removal script is required');
  if (
    process.platform === 'win32' &&
    fs.realpathSync.native(main) !== fs.realpathSync.native(path.dirname(common))
  )
    throw new Error(
      'Safe Windows cleanup requires a main checkout with its Git directory inside it',
    );
  const cleanup = async () => {
    if (fs.lstatSync(tree).isSymbolicLink()) throw new Error('Evaluation root became a link');
    if (process.platform === 'win32') {
      await execute(
        'powershell',
        ['-NoProfile', '-File', script, '-Path', tree, '-DiscardChanges'],
        { env: withoutOperatorToken(process.env), cwd, windowsHide: true },
      );
    } else {
      unlinkTreeLinks(tree);
      await execute('git', ['worktree', 'remove', '--force', tree], {
        env: withoutOperatorToken(process.env),
        cwd,
        windowsHide: true,
      });
    }
    // No branch, dependency installation or Git configuration was created.
    if (evalGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !== common)
      throw new Error('Git common directory changed');
  };
  try {
    await execute('git', ['worktree', 'add', '--detach', tree, base], {
      env: withoutOperatorToken(process.env),
      cwd,
      windowsHide: true,
    });
  } catch (error) {
    // Git may register a tree and then fail its checkout (disk/checkout filter error).
    if (
      evalGit(cwd, ['worktree', 'list', '--porcelain', '-z'])
        .split('\0')
        .includes(`worktree ${tree.replace(/\\/g, '/')}`)
    )
      await cleanup();
    throw error;
  }
  return {
    path: tree,
    cleanup,
  };
}
