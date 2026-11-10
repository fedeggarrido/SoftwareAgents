import { describe, expect, it } from 'vitest';

import { officeHelpPlacement } from '../src/office/helpPlacement.js';

describe('office access help placement', () => {
  it.each([
    { naturalTop: 44, hudBottom: 190, height: 844 },
    { naturalTop: 44, hudBottom: 520, height: 844 },
    { naturalTop: 210, hudBottom: 190, height: 400 },
    { naturalTop: 44, hudBottom: 0, height: 844 },
  ])(
    'keeps help clear of the HUD and within the viewport: %j',
    ({ naturalTop, hudBottom, height }) => {
      const placement = officeHelpPlacement(naturalTop, hudBottom, height);
      const helpTop = naturalTop + placement.marginTop;
      expect(helpTop).toBeGreaterThan(hudBottom);
      expect(helpTop).toBeGreaterThanOrEqual(naturalTop);
      expect(placement.maxHeight).toBeGreaterThan(0);
      expect(helpTop + placement.maxHeight).toBeLessThan(height);
    },
  );

  it('moves help as the HUD expands and restores space when it collapses', () => {
    const collapsed = officeHelpPlacement(44, 190, 844);
    const expanded = officeHelpPlacement(44, 520, 844);
    expect(expanded.marginTop).toBeGreaterThan(collapsed.marginTop);
    expect(expanded.maxHeight).toBeLessThan(collapsed.maxHeight);
    expect(officeHelpPlacement(44, 190, 844)).toEqual(collapsed);
  });

  it('never produces a negative size when the HUD exceeds a small viewport', () => {
    const placement = officeHelpPlacement(44, 520, 400);
    expect(44 + placement.marginTop).toBeGreaterThan(520);
    expect(placement.maxHeight).toBe(0);
  });
});
