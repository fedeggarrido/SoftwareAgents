import { execFileSync } from 'child_process';

import { evalGit } from './evalTasks.js';

/** Check the ref itself, including dangling symbolic refs omitted by for-each-ref. */
export function assertDirectRef(repository: string, ref: string): void {
  let target: string;
  try {
    target = execFileSync('git', ['symbolic-ref', '--quiet', '--no-recurse', ref], {
      cwd: repository,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if ((error as { status?: number }).status === 1) return;
    throw error;
  }
  throw new Error(`Symbolic publication ref rejected: ${ref} → ${target}`);
}

/** Never dereference a publication target, even if it is substituted after inspection. */
export function publishDirectRef(
  repository: string,
  ref: string,
  after: string,
  before: string,
): void {
  if (!ref.startsWith('refs/heads/sa/')) throw new Error('Invalid publication target');
  assertDirectRef(repository, ref);
  assertDirectRef(repository, 'refs/heads/main');
  const main = evalGit(repository, ['rev-parse', 'refs/heads/main^{commit}']);
  evalGit(repository, [
    '-c',
    'core.hooksPath=',
    '-c',
    'core.fsmonitor=false',
    'update-ref',
    '--no-deref',
    ref,
    after,
    before,
  ]);
  if (evalGit(repository, ['rev-parse', 'refs/heads/main^{commit}']) !== main)
    throw new Error('main moved during publication; human reconciliation required');
  assertDirectRef(repository, ref);
}
