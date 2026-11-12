import { execFile } from 'node:child_process';

import { afterEach, expect, it, vi } from 'vitest';

import { GITHUB_COMMAND_TIMEOUT_MS } from '../src/constants.js';
import { runGithubCommand } from '../src/githubCommand.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => callback(null, 'operador', ''),
  ),
}));
afterEach(() => vi.unstubAllEnvs());

it('uses execFile with bounded time, no shell and no operator capability or token arguments', async () => {
  vi.stubEnv('PIXEL_AGENTS_OPERATOR_TOKEN', 'private-operator-capability');
  await expect(
    runGithubCommand('gh', ['api', 'user', '--jq', '.login'], '/isolated'),
  ).resolves.toMatchObject({ code: 0, stdout: 'operador' });
  expect(execFile).toHaveBeenCalledWith(
    'gh',
    ['api', 'user', '--jq', '.login'],
    expect.objectContaining({
      cwd: '/isolated',
      timeout: GITHUB_COMMAND_TIMEOUT_MS,
      windowsHide: true,
      env: expect.objectContaining({ GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' }),
    }),
    expect.any(Function),
  );
  expect(JSON.stringify(vi.mocked(execFile).mock.calls)).not.toContain(
    'private-operator-capability',
  );
  const options = vi.mocked(execFile).mock.calls[0][2];
  expect(options).not.toHaveProperty('shell');
});
