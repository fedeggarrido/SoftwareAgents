import { describe, expect, it } from 'vitest';

import type { BoardDecision, MeetingState } from '../../core/src/messages.js';
import { visibleAreas } from '../src/office/engine/seatPlacement.js';
import { meetingPresentation } from '../src/office/meetingPresentation.js';

const meeting: MeetingState = {
  id: 'm1',
  format: 'delphi',
  topic: 'Recibos',
  question: '¿Qué hacemos?',
  participants: [],
  status: 'running',
  round: 'critica',
  task: 'T1',
  lines: [
    { at: 1, round: 'borrador', role: 'qa', stance: 'Uno' },
    { at: 2, round: 'borrador', role: 'reviewer', stance: 'Dos' },
  ],
};
const decision: BoardDecision = {
  id: 'd1',
  question: '¿Esperar?',
  options: [],
  status: 'open',
  blocks: ['T1'],
};

describe('meetingPresentation', () => {
  it('shows each round once and marks the current one', () => {
    const view = meetingPresentation(meeting);
    expect(view.chip).toBe('meeting');
    expect(view.format).toBe('Opiniones por rondas');
    expect(view.rounds).toEqual([
      { label: 'Propuestas independientes', current: false },
      { label: 'Revisión entre agentes', current: true },
    ]);
    expect(view.intervention).toContain('No consta que necesite tu intervención');
  });

  it('links only an open decision on the same task', () => {
    expect(meetingPresentation(meeting, [decision]).decision).toBe(decision);
    for (const other of [
      { ...decision, status: 'answered' },
      { ...decision, blocks: ['T2'] },
      { ...decision, blocks: undefined },
    ])
      expect(meetingPresentation(meeting, [other]).decision).toBeUndefined();
    expect(
      meetingPresentation({ ...meeting, task: undefined }, [decision]).decision,
    ).toBeUndefined();
  });

  it.each([
    ['escalated', 'meeting_escalated', 'en tus manos'],
    ['decided', 'meeting_decided', 'terminada'],
    ['waiting_quota', 'WAITING_QUOTA', 'capacidad'],
    ['constructor', 'unknown', 'No consta en qué estado'],
  ])('explains %s without leaking raw states', (status, chip, text) => {
    const view = meetingPresentation({ ...meeting, status });
    expect(view.chip).toBe(chip);
    expect(view.intervention).toContain(text);
    expect(view.rounds.some(({ current }) => current)).toBe(status === 'waiting_quota');
  });

  it('names an unrecognised round without showing its identifier', () => {
    expect(meetingPresentation({ ...meeting, round: 'x-9', format: 'x' })).toMatchObject({
      format: undefined,
      rounds: [{}, { label: 'Ronda sin nombre registrado' }],
    });
  });
});

describe('visibleAreas', () => {
  const layout = {
    areas: [{ label: 'Sala de reuniones', color: 'white' }],
    areaTiles: ['Sala de reuniones', 'QA', null],
  };
  it('shows only the meeting room while a meeting runs', () => {
    expect(visibleAreas(layout, false, true).areaTiles).toEqual(['Sala de reuniones', null, null]);
    expect(visibleAreas(layout, false, false)).toEqual({});
    expect(visibleAreas(layout, true, true)).toEqual(layout);
  });
});
