import { describe, expect, it } from 'vitest';

import { edgeShift } from '../src/office/edgeShift.js';

describe('edgeShift', () => {
  it('leaves a label that fits where it is', () => {
    expect(edgeShift(20, 80, 8, 382)).toBe(0);
  });
  it('pushes a label cut at the left edge back inside', () => {
    expect(edgeShift(-40, 120, 8, 382)).toBe(48);
  });
  it('pulls a label cut at the right edge back inside', () => {
    expect(edgeShift(300, 420, 8, 382)).toBe(-38);
  });
  it('aligns a label wider than the office to the left edge', () => {
    expect(edgeShift(-100, 500, 8, 382)).toBe(108);
  });
});
