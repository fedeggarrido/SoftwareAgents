import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { checkEvalCriteria } from '../src/evalCriteria.js';
import { loadEvalTasks } from '../src/evalTasks.js';

const source = path.resolve(__dirname, '../..');
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-bank-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

// No model calls or registered worktrees. Archive historical source into test-owned directories.
it.each(loadEvalTasks(source))(
  '$id verifier fails before the fix and passes after it',
  async (task) => {
    for (const [commit, expected] of [
      [task.baseCommit, false],
      [task.fixCommit, true],
    ] as const) {
      const tree = path.join(root, expected ? 'fixed' : 'base');
      const scratch = path.join(root, expected ? 'verify-fixed' : 'verify-base');
      fs.mkdirSync(tree);
      fs.mkdirSync(scratch);
      const archive = path.join(root, 'source.tar');
      execFileSync('git', ['archive', '--format=tar', '--output', archive, commit], {
        cwd: source,
        windowsHide: true,
      });
      // A relative archive avoids GNU tar treating the Windows drive as a remote host.
      execFileSync('tar', ['-xf', path.basename(archive), '-C', path.basename(tree)], {
        cwd: root,
        windowsHide: true,
      });
      try {
        expect(await checkEvalCriteria(task, source, tree, scratch)).toEqual(
          task.criteria.map(() => expected),
        );
      } finally {
        // Remove only our dependency link, before any recursive test cleanup.
        const link = path.join(tree, 'node_modules');
        if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(link);
      }
    }
  },
  30_000,
);
