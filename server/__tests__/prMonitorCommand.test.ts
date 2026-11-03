import { afterEach, describe, expect, it, vi } from 'vitest';

import { GH_PR_FIELDS, GH_PR_MAX_BUFFER_BYTES, GH_PR_TIMEOUT_MS } from '../src/constants.js';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, { value: execute });
  return { ...actual, execFile };
});
const { readPullRequest } = await import('../src/prMonitor.js');

afterEach(() => {
  execute.mockReset();
  vi.unstubAllEnvs();
});

describe('gh invocation boundary', () => {
  it('uses bounded execFile argv and strips every operator token variant', async () => {
    vi.stubEnv('PIXEL_AGENTS_OPERATOR_TOKEN', 'private');
    vi.stubEnv('pixel_agents_operator_token', 'private');
    vi.stubEnv('GH_TOKEN', 'github-credential');
    execute.mockResolvedValue({ stdout: '{}', stderr: '' });
    expect(await readPullRequest('repo', 'branch with spaces; echo test')).toBe('{}');
    expect(execute).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', 'branch with spaces; echo test', '--json', GH_PR_FIELDS],
      expect.objectContaining({
        cwd: 'repo',
        windowsHide: true,
        timeout: GH_PR_TIMEOUT_MS,
        maxBuffer: GH_PR_MAX_BUFFER_BYTES,
      }),
    );
    const options = execute.mock.calls[0][2];
    expect(options.shell).toBeUndefined();
    expect(options.env.GH_TOKEN).toBe('github-credential');
    expect(
      Object.keys(options.env).some((key) => key.toUpperCase() === 'PIXEL_AGENTS_OPERATOR_TOKEN'),
    ).toBe(false);
  });
  it.each(['', '--web', '\n42'])('rejects invalid selector %j before invoking gh', async (ref) => {
    await expect(readPullRequest('repo', ref)).rejects.toThrow('Invalid PR reference');
    expect(execute).not.toHaveBeenCalled();
  });
  it('propagates missing gh to the monitor fail-soft boundary', async () => {
    execute.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    await expect(readPullRequest('repo', '42')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
