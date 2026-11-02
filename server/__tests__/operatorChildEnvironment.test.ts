import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { evalGit } from '../src/evalTasks.js';
import { createEvalWorktree } from '../src/evalWorktree.js';
import { OPERATOR_TOKEN_ENV } from '../src/featureIngress.js';

vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-child-'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/remove-worktree.ps1'), '# fixture');
  vi.stubEnv(OPERATOR_TOKEN_ENV, 'operator-secret');
  vi.stubEnv('pixel_agents_operator_token', 'case-override');
  vi.mocked(execFileSync).mockImplementation(((_binary: string, args: string[]) => {
    if (args[0] === 'worktree') return `worktree ${root}\0`;
    if (args[0] === 'rev-parse') return path.join(root, '.git');
    return 'result';
  }) as typeof execFileSync);
  vi.mocked(execFile).mockImplementation(((
    _binary: string,
    args: string[],
    _options: unknown,
    callback: (error: null, stdout: string, stderr: string) => void,
  ) => {
    if (args[0] === 'worktree' && args[1] === 'add') fs.mkdirSync(args[3], { recursive: true });
    callback(null, '', '');
    return {};
  }) as typeof execFile);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

it('strips the capability from eval git, checkout and the platform cleanup helper', async () => {
  expect(evalGit(root, ['status'])).toBe('result');
  const tree = await createEvalWorktree(root, path.join(root, '.git'), 'HEAD');
  await tree.cleanup();
  expect(execFile).toHaveBeenCalledTimes(2);
  for (const calls of [vi.mocked(execFileSync).mock.calls, vi.mocked(execFile).mock.calls]) {
    for (const call of calls) {
      const options = call[2] as { env: NodeJS.ProcessEnv };
      expect(options.env).toBeDefined();
      expect(Object.keys(options.env).some((key) => key.toUpperCase() === OPERATOR_TOKEN_ENV)).toBe(
        false,
      );
      expect(options.env.PATH).toBe(process.env.PATH);
    }
  }
  expect(process.env[OPERATOR_TOKEN_ENV]).toBeDefined();
});
