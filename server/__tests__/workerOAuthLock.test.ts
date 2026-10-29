import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, expect, it, vi } from 'vitest';

import { clearWorkerOAuthLock, noClaudeProcess } from '../src/workerOAuthLock.js';

vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  execFileSync: vi.fn(),
}));

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true });
});

it.skipIf(process.platform !== 'win32').each(['0', '1', '', 'denied'])(
  'uses a bounded process probe and retains uncertainty: %s',
  (result) => {
    const probe = vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      if (result === 'denied') throw new Error('CIM denied');
      return result as never;
    });
    expect(noClaudeProcess()).toBe(result === '0');
    expect(probe).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-NoProfile', '-NonInteractive']),
      expect.objectContaining({ timeout: expect.any(Number), windowsHide: true }),
    );
  },
);
function fixture(content = '{"pid":12345}') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-lock-'));
  directories.push(directory);
  const lock = path.join(directory, '.oauth_refresh.lock');
  fs.writeFileSync(lock, content);
  return { directory, lock };
}
it('removes and audits a dead owner only after verified process absence', () => {
  const { directory, lock } = fixture();
  const audit = vi.fn();
  expect(
    clearWorkerOAuthLock(
      directory,
      audit,
      () => true,
      () => null,
    ),
  ).toBe(true);
  expect(audit).toHaveBeenCalledOnce();
  expect(fs.existsSync(lock)).toBe(false);
});
it.each(['live', 'unknown', 'other-process', 'probe-error', 'audit-error', 'changed'])(
  'retains lock: %s',
  (mode) => {
    const { directory, lock } = fixture();
    const audit = vi.fn(() => {
      if (mode === 'audit-error') throw new Error('audit unavailable');
    });
    const absent = () => {
      if (mode === 'probe-error') throw new Error('access denied');
      if (mode === 'changed') fs.writeFileSync(lock, '{"pid":54321}');
      return mode !== 'other-process';
    };
    expect(
      clearWorkerOAuthLock(directory, audit, absent, () =>
        mode === 'live' ? 'identity' : mode === 'unknown' ? undefined : null,
      ),
    ).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
  },
);
it.each(['', '{}', 'null', '{"pid":-1}', '{"pid":"123"}'])(
  'retains an unrecognized lock %s',
  (content) => {
    const { directory, lock } = fixture(content);
    expect(
      clearWorkerOAuthLock(
        directory,
        vi.fn(),
        () => true,
        () => null,
      ),
    ).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
  },
);
