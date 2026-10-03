import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { processStartIdentity, terminateExecutionTree } from '../src/workstore/processRecovery.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(execFileSync).mockReset();
});

describe('executor process identity recovery', () => {
  it('rejects unsafe PIDs without querying or terminating processes', () => {
    const kill = vi.spyOn(process, 'kill');
    for (const pid of [-1, 0, 1.5, NaN, process.pid])
      expect(() => terminateExecutionTree(pid, 'identity')).toThrow('Invalid executor PID');
    expect(kill).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it('does nothing for dead processes and fails closed on access errors', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    expect(processStartIdentity(123)).toBeNull();
    expect(() => terminateExecutionTree(123, null)).not.toThrow();
    kill.mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    expect(() => terminateExecutionTree(123, 'identity')).toThrow('denied');
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform !== 'win32')(
    'never kills a reused PID or one lacking an identity',
    () => {
      vi.spyOn(process, 'kill').mockReturnValue(true);
      vi.mocked(execFileSync).mockReturnValue('123456');
      terminateExecutionTree(123, 'different');
      expect(execFileSync).toHaveBeenCalledTimes(1);
      expect(() => terminateExecutionTree(123, null)).toThrow('lacks a recorded');
      expect(vi.mocked(execFileSync).mock.calls.every(([cmd]) => cmd === 'powershell.exe')).toBe(
        true,
      );
    },
  );
  it.skipIf(process.platform !== 'win32')(
    'uses taskkill /T /F only after verifying identity and checks termination',
    () => {
      vi.spyOn(process, 'kill').mockReturnValue(true);
      vi.mocked(execFileSync)
        .mockReturnValueOnce('123456')
        .mockReturnValueOnce('')
        .mockReturnValueOnce('');
      terminateExecutionTree(123, '123456');
      expect(execFileSync).toHaveBeenNthCalledWith(
        2,
        'taskkill.exe',
        ['/PID', '123', '/T', '/F'],
        expect.objectContaining({ windowsHide: true }),
      );
    },
  );
  it.skipIf(process.platform !== 'win32')(
    'blocks when taskkill fails or the executor remains live',
    () => {
      vi.spyOn(process, 'kill').mockReturnValue(true);
      vi.mocked(execFileSync).mockImplementation((cmd) => {
        if (cmd === 'taskkill.exe') throw new Error('taskkill denied');
        return '123456';
      });
      expect(() => terminateExecutionTree(123, '123456')).toThrow('taskkill denied');
      vi.mocked(execFileSync).mockReturnValue('123456');
      expect(() => terminateExecutionTree(123, '123456')).toThrow('still alive');
    },
  );
  it.skipIf(process.platform !== 'win32')(
    'blocks when the OS creation identity cannot be read',
    () => {
      vi.spyOn(process, 'kill').mockReturnValue(true);
      vi.mocked(execFileSync).mockReturnValue('unreadable');
      expect(() => terminateExecutionTree(123, '123456')).toThrow('Cannot verify');
    },
  );
});
