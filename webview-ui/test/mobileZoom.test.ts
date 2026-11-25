import { describe, expect, it } from 'vitest';

import { mobileFitZoom, MobileZoomPolicy } from '../src/office/mobileZoom.js';

describe('mobile camera fit', () => {
  it.each([1, 2, 3])('fits the default office at 375 CSS pixels with DPR %s', (dpr) => {
    const zoom = mobileFitZoom(375, dpr, 20);
    expect((20 * 16 * zoom) / dpr).toBeLessThanOrEqual(375);
    expect(Number.isInteger(zoom)).toBe(true);
  });
  it('fits again after rotating an untouched camera', () => {
    const policy = new MobileZoomPolicy(2);
    expect(policy.fit(375, 1, 20, false)).toBe(1);
    policy.observe(1);
    expect(policy.fit(700, 1, 20, false)).toBe(2);
  });
  it('restores the original zoom when an untouched camera widens to desktop', () => {
    const policy = new MobileZoomPolicy(3);
    expect(policy.fit(375, 1, 20, false)).toBe(1);
    policy.observe(1);
    expect(policy.fit(1024, 1, 20, false)).toBe(3);
  });
  it('leaves follow and desktop alone', () => {
    const policy = new MobileZoomPolicy(2);
    expect(policy.fit(375, 1, 20, true)).toBeNull();
    expect(policy.fit(1024, 1, 20, false)).toBeNull();
  });
  it('keeps manual ownership after returning to the fitted level', () => {
    const policy = new MobileZoomPolicy(2);
    expect(policy.fit(375, 1, 20, false)).toBe(1);
    policy.observe(1);
    policy.observe(3);
    policy.observe(1);
    expect(policy.fit(700, 1, 20, false)).toBeNull();
  });
});
