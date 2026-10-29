import { expect, it, vi } from 'vitest';

import { DESIGN_CANVAS_READY_TIMEOUT_MS } from '../src/constants.js';
import { waitForDesignCanvas } from '../src/designCapture.js';

it('waits for a rendered frame rather than canvas presence', async () => {
  let finish!: () => void;
  const waitFor = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const locator = vi.fn(() => ({ waitFor }));
  let ready = false;
  const pending = waitForDesignCanvas({ locator }).then(() => {
    ready = true;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  expect(locator).toHaveBeenCalledWith('canvas[data-ready="true"]');
  expect(waitFor).toHaveBeenCalledWith({ timeout: DESIGN_CANVAS_READY_TIMEOUT_MS });
  finish();
  await pending;
  expect(ready).toBe(true);
});

it('rejects blank evidence when the readiness wait times out', async () => {
  await expect(
    waitForDesignCanvas({
      locator: () => ({ waitFor: () => Promise.reject(new Error('Timeout')) }),
    }),
  ).rejects.toThrow('invalid capture; office canvas was not ready');
});
