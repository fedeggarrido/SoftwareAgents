import { afterEach, expect, it, vi } from 'vitest';

import { openOffice, presentOfficeAccess, shouldOpenOffice } from '../src/openOffice.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), on: vi.fn(), unref: vi.fn() }));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));
afterEach(() => {
  vi.restoreAllMocks();
  mocks.spawn.mockReset();
  vi.unstubAllEnvs();
});

it('passes only a bootstrap code to the browser without logging it or inheriting operator credentials', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.spawn.mockReturnValue({ on: mocks.on, unref: mocks.unref });
  const url = `http://127.0.0.1:1234/?open=${'a'.repeat(64)}`;
  openOffice(url);
  expect(mocks.spawn.mock.calls[0][1]).toContain(url);
  expect(JSON.stringify(mocks.spawn.mock.calls[0][1])).not.toContain('token');
  expect(mocks.spawn.mock.calls[0][2].env).not.toHaveProperty('PIXEL_AGENTS_OPERATOR_TOKEN');
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});

it('keeps the token out of logs even when process creation throws an error containing argv', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.spawn.mockImplementation(() => {
    throw new Error('spawn ?token=secret');
  });
  expect(() => openOffice(`http://127.0.0.1:1234/?open=${'b'.repeat(64)}`)).not.toThrow();
  expect(error).toHaveBeenCalledOnce();
  expect(JSON.stringify(error.mock.calls)).not.toContain('secret');
});

it('refuses persistent capabilities before spawning any process', () => {
  openOffice('http://127.0.0.1:1234/?token=persistent-secret');
  openOffice(`http://127.0.0.1:1234/?open=${'a'.repeat(64)}&token=persistent-secret`);
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it('requires two TTYs and supports --no-open', () => {
  for (const key of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(key, undefined);
  expect(shouldOpenOffice(false, true, true, {})).toBe(true);
  expect(shouldOpenOffice(false, false, true, {})).toBe(false);
  expect(shouldOpenOffice(false, true, false, {})).toBe(false);
  expect(shouldOpenOffice(true, true, true, {})).toBe(false);
});

it.each(['CI', 'VITEST', 'PLAYWRIGHT', 'PIXEL_AGENTS_NO_OPEN'])(
  'excludes %s even if empty',
  (key) => {
    expect(shouldOpenOffice(false, true, true, { [key]: '' })).toBe(false);
  },
);

it('excludes NODE_ENV=test', () => {
  expect(shouldOpenOffice(false, true, true, { NODE_ENV: 'test' })).toBe(false);
});

it.each(['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])(
  'excludes managed marker %s',
  (key) => {
    vi.stubEnv(key, '');
    expect(shouldOpenOffice(false, true, true, {})).toBe(false);
  },
);

function humanTerminal() {
  for (const key of [
    'SA_MANAGED_EXECUTION',
    'SA_AUTOPILOT',
    'SA_WORKER',
    'CLAUDECODE',
    'CI',
    'VITEST',
    'PLAYWRIGHT',
    'PIXEL_AGENTS_NO_OPEN',
    'NODE_ENV',
  ])
    vi.stubEnv(key, undefined);
  vi.spyOn(process, 'stdin', 'get').mockReturnValue({ isTTY: true } as typeof process.stdin);
  vi.spyOn(process, 'stdout', 'get').mockReturnValue({ isTTY: true } as typeof process.stdout);
}

it.each(['--no-open', 'PIXEL_AGENTS_NO_OPEN'])(
  'prints a one-time link on an interactive human start with %s',
  async (mode) => {
    humanTerminal();
    if (mode === 'PIXEL_AGENTS_NO_OPEN') vi.stubEnv('PIXEL_AGENTS_NO_OPEN', '1');
    const url = `http://127.0.0.1:1234/?open=${'c'.repeat(64)}`;
    const getUrl = vi.fn().mockResolvedValue(url);
    const log = vi.fn();
    await presentOfficeAccess(getUrl, mode === '--no-open', log);
    expect(getUrl).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(url));
    expect(log).toHaveBeenCalledWith('Si caduca: pixel-agents open');
    expect(mocks.spawn).not.toHaveBeenCalled();
  },
);

it.each(['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE', 'no TTY'])(
  'issues no link at startup with %s',
  async (mode) => {
    humanTerminal();
    if (mode === 'no TTY')
      vi.spyOn(process, 'stdin', 'get').mockReturnValue({ isTTY: false } as typeof process.stdin);
    else vi.stubEnv(mode, '');
    const getUrl = vi.fn();
    const log = vi.fn();
    await presentOfficeAccess(getUrl, true, log);
    expect(getUrl).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  },
);
