import { PR_MAX_STRING_CHARS } from './constants.js';

export function validatePrSelector(value: string): void {
  if (
    !value.trim() ||
    value.length > PR_MAX_STRING_CHARS ||
    value.startsWith('-') ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
    throw new Error('Invalid PR reference');
}

/** Canonical identity includes host, owner, repository and positive PR number. */
export function canonicalPullRequest(value: string, repository?: string): string {
  validatePrSelector(value);
  const url = new URL(value);
  const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/.exec(url.pathname);
  // URL.port normalizes an explicit :443, so check the raw authority as well.
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !/^https:\/\/[^/:@?#]+\//i.test(value) ||
    url.search ||
    url.hash ||
    !match ||
    !Number.isSafeInteger(Number(match[3]))
  )
    throw new Error('Invalid PR URL');
  const repo = `https://${url.hostname}/${match[1]}/${match[2]}`.toLowerCase();
  if (repository && repo !== repository) throw new Error('PR repository does not match binding');
  return `${repo}/pull/${Number(match[3])}`;
}

/** Project repo.remote is only an identity. It never supplies executable argv. */
export function pullRequestRepository(remote: string): string {
  validatePrSelector(remote);
  const https = remote.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '');
  return canonicalPullRequest(`${https}/pull/1`).replace(/\/pull\/1$/, '');
}
