import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { processStartIdentity, terminateExecutionTree } from '../src/workstore/processRecovery.js';

vi.mock('node:child_process', () => {
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: vi.fn(),
  });
  return { execFile };
});
const execute = vi.mocked(promisify(execFile));

afterEach(() => {
  vi.restoreAllMocks();
  execute.mockReset();
});

describe('async executor identity recovery', () => {
  it('rejects unsafe PIDs before any OS action', async () => {
    const kill = vi.spyOn(process, 'kill');
    for (const pid of [-1, 0, 1.5, NaN, process.pid])
      await expect(terminateExecutionTree(pid, '123')).rejects.toThrow('Invalid executor PID');
    expect(kill).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('returns null for a dead identity query and preserves access errors', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    expect(await processStartIdentity(123)).toBeNull();
    kill.mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    await expect(processStartIdentity(123)).rejects.toThrow('denied');
    expect(execute).not.toHaveBeenCalled();
  });
  it('refuses absent or injectable identities even when the root is gone', async () => {
    for (const identity of [null, '', "123'; Stop-Process", 'approximate'])
      await expect(terminateExecutionTree(123, identity)).rejects.toThrow('tree closure unproven');
    expect(execute).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform !== 'win32')(
    'requires explicit tree closure and propagates helper failures',
    async () => {
      execute.mockResolvedValue({ stdout: 'TREE_CLOSED\r\n', stderr: '' });
      await terminateExecutionTree(123, '123456');
      expect(execute).toHaveBeenCalledWith(
        'powershell.exe',
        expect.any(Array),
        expect.objectContaining({ windowsHide: true }),
      );
      execute.mockResolvedValue({ stdout: '', stderr: '' });
      await expect(terminateExecutionTree(123, '123456')).rejects.toThrow('tree closure unproven');
      for (const failure of ['root disappeared', 'PID reused', 'access denied', 'timeout']) {
        execute.mockRejectedValue(new Error(failure));
        await expect(terminateExecutionTree(123, '123456')).rejects.toThrow(failure);
      }
    },
  );
  it.skipIf(process.platform !== 'win32')('rejects unreadable OS creation timestamps', async () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    execute.mockResolvedValue({ stdout: 'unreadable', stderr: '' });
    await expect(processStartIdentity(123)).rejects.toThrow('Cannot verify');
  });
});
