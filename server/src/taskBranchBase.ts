import * as fs from 'fs';
import * as path from 'path';

import { evalGit } from './evalTasks.js';
import { assertDirectRef } from './gitPublication.js';
import { resolveInside } from './pathGuard.js';

export function taskBranchBaseFile(repository: string, branch: string): string {
  const common = path.resolve(repository, evalGit(repository, ['rev-parse', '--git-common-dir']));
  return resolveInside(common, `softwareagents/task-bases/${encodeURIComponent(branch)}.json`);
}

/** Runtime-owned metadata in the common Git directory, outside the agent's writable tree. */
export function taskBranchBase(
  repository: string,
  branch: string,
  defaultBranch: string,
  create = false,
): string {
  assertDirectRef(repository, `refs/heads/${branch}`);
  assertDirectRef(repository, `refs/heads/${defaultBranch}`);
  const file = taskBranchBaseFile(repository, branch);
  if (fs.existsSync(file + '.rebase'))
    throw new Error('Task rebase pending; human reconciliation required');
  const exists = evalGit(repository, [
    'for-each-ref',
    '--format=%(refname)',
    `refs/heads/${branch}`,
  ])
    .split('\n')
    .includes(`refs/heads/${branch}`);
  if (!fs.existsSync(file)) {
    if (!create || exists)
      throw new Error(
        'Developer branch has no registered trusted base; human reconciliation required',
      );
    const base = evalGit(repository, ['rev-parse', `${defaultBranch}^{commit}`]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ branch, base }), { flag: 'wx' });
  }
  const record = JSON.parse(fs.readFileSync(file, 'utf8')) as { branch: string; base: string };
  if (record.branch !== branch || !/^[a-f0-9]{40,64}$/.test(record.base))
    throw new Error('Invalid registered trusted base; human reconciliation required');
  const integrated =
    /^sa\/FEAT-\d{3}-integration$/.test(defaultBranch) &&
    exists &&
    evalGit(repository, ['merge-base', defaultBranch, branch]) ===
      evalGit(repository, ['rev-parse', branch]) &&
    evalGit(repository, ['merge-base', record.base, branch]) === record.base;
  if (
    exists &&
    !integrated &&
    evalGit(repository, ['merge-base', defaultBranch, branch]) !== record.base
  )
    throw new Error('Developer branch merge-base differs from registered trusted base');
  return record.base;
}
