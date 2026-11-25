import { describe, expect, it } from 'vitest';

import { canShowTour } from '../src/hooks/tourVisibility.js';

describe('tour visibility', () => {
  it('allows an unobstructed office', () => {
    expect(canShowTour({ panel: false, dialog: false, settings: false })).toBe(true);
  });
  it.each(['panel', 'dialog', 'settings', 'editor', 'agent', 'migration'])(
    'pauses for %s',
    (surface) => {
      expect(canShowTour({ panel: false, dialog: false, settings: false, [surface]: true })).toBe(
        false,
      );
    },
  );
  it('resumes only after every surface closes', () => {
    expect(canShowTour({ panel: false, settings: true })).toBe(false);
    expect(canShowTour({ panel: false, settings: false })).toBe(true);
  });
});
