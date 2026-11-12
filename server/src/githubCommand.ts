import { execFile } from 'node:child_process';

import type { GithubHostingError } from '../../core/src/messages.js';
import { GITHUB_COMMAND_MAX_BUFFER, GITHUB_COMMAND_TIMEOUT_MS } from './constants.js';
import { withoutOperatorToken } from './featureIngress.js';

export interface GithubCommandResult {
  stdout: string;
  stderr: string;
  code: string | number | null;
}
export type GithubCommandRunner = (
  command: 'gh' | 'git',
  args: string[],
  cwd: string,
) => Promise<GithubCommandResult>;

/** Credentials stay with the CLI. Neither command output nor process errors are logged. */
export const runGithubCommand: GithubCommandRunner = (command, args, cwd) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd,
        env: {
          ...withoutOperatorToken(process.env),
          GH_HOST: 'github.com',
          GH_PROMPT_DISABLED: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
        timeout: GITHUB_COMMAND_TIMEOUT_MS,
        maxBuffer: GITHUB_COMMAND_MAX_BUFFER,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          code: error ? (error.code ?? (error.killed ? 'ETIMEDOUT' : 'failed')) : 0,
        });
      },
    );
  });

export class GithubHostingFailure extends Error {
  constructor(readonly code: GithubHostingError) {
    super(code);
  }
}

export function failGithub(code: GithubHostingError): never {
  throw new GithubHostingFailure(code);
}

/** Only fixed error codes cross the boundary, even if gh prints a credential. */
export function githubCommandError(
  result: GithubCommandResult,
  command: 'gh' | 'git' = 'gh',
): GithubHostingError {
  const text = `${result.code}\n${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.code === 'ENOENT') return command === 'gh' ? 'gh_missing' : 'unavailable';
  if (/already exists|name already|name.*taken/.test(text)) return 'name_taken';
  if (/401|bad credentials|authentication|auth login|not logged|token.*expired/.test(text))
    return 'unauthenticated';
  if (/403|forbidden|permission|not accessible/.test(text)) return 'permission_denied';
  if (/network|resolve host|connection|timed? out|timeout|etimedout|econn|enotfound|tls/.test(text))
    return 'network';
  return 'unavailable';
}
