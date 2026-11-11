import { describe, expect, it } from 'vitest';

import { backlogGroupOf, backlogPulse, groupBacklog } from '../src/office/backlogGroups.js';

describe('backlog groups (SA-152)', () => {
  it('puts work waiting for the human first and unknown phases in Pendientes', () => {
    expect(backlogGroupOf('WAITING_HUMAN')).toBe('needsYou');
    expect(backlogGroupOf('RUNNING')).toBe('inProgress');
    expect(backlogGroupOf('DONE')).toBe('done');
    expect(backlogGroupOf('SOMETHING_NEW')).toBe('pending');
  });

  it('counts the three pulse numbers', () => {
    expect(backlogPulse(['RUNNING', 'REVIEW', 'WAITING_HUMAN', 'BLOCKED', 'DONE'])).toEqual({
      working: 2,
      needsYou: 1,
      blocked: 1,
    });
  });

  it('keeps the fixed group order', () => {
    const groups = groupBacklog([
      { phase: 'DONE' },
      { phase: 'QUEUED' },
      { phase: 'AWAITING_REVIEW' },
    ]);
    expect(groups.map((g) => [g.id, g.items.length])).toEqual([
      ['needsYou', 1],
      ['inProgress', 0],
      ['pending', 1],
      ['done', 1],
    ]);
  });
});
