import { afterEach, expect, it, vi } from 'vitest';

import { shutdownPullRequestMonitor } from '../src/cli.js';
import { PR_SHUTDOWN_TIMEOUT_MS } from '../src/constants.js';

afterEach(() => vi.useRealTimers());

it('waits for disposal to finish before standalone shutdown returns', async () => {
  let finish: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const dispose = vi.fn(() => pending);
  let done = false;
  const shutdown = shutdownPullRequestMonitor({ dispose }).then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  finish();
  await shutdown;
  expect(done).toBe(true);
  expect(dispose).toHaveBeenCalledOnce();
});

it('bounds standalone waiting when a transport does not finish', async () => {
  vi.useFakeTimers();
  const dispose = vi.fn(() => new Promise<void>(() => {}));
  const shutdown = shutdownPullRequestMonitor({ dispose });
  await vi.advanceTimersByTimeAsync(PR_SHUTDOWN_TIMEOUT_MS);
  await shutdown;
  expect(vi.getTimerCount()).toBe(0);
});
