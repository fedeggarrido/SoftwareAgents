import { afterEach, expect, it, vi } from 'vitest';

import { openOffice } from '../src/openOffice.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), on: vi.fn(), unref: vi.fn() }));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));
afterEach(() => {
  vi.restoreAllMocks();
  mocks.spawn.mockReset();
});

it('passes the capability directly to the browser without logging it or inheriting operator credentials', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.spawn.mockReturnValue({ on: mocks.on, unref: mocks.unref });
  const url = 'http://127.0.0.1:1234/?token=private-capability';
  openOffice(url);
  expect(mocks.spawn.mock.calls[0][1]).toContain(url);
  expect(mocks.spawn.mock.calls[0][2].env).not.toHaveProperty('PIXEL_AGENTS_OPERATOR_TOKEN');
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});

it('keeps the token out of logs even when process creation throws an error containing argv', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.spawn.mockImplementation(() => {
    throw new Error('spawn ?token=secret');
  });
  expect(() => openOffice('http://127.0.0.1:1234/?token=secret')).not.toThrow();
  expect(error).toHaveBeenCalledOnce();
  expect(JSON.stringify(error.mock.calls)).not.toContain('secret');
});
