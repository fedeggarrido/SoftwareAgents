import { describe, expect, it } from 'vitest';

import type { BoardDecision, BoardItem } from '../../core/src/messages.js';
import { inboxTitle, ownerInbox } from '../src/office/ownerInbox.js';

const decision = (id: string, extra: Partial<BoardDecision> = {}): BoardDecision => ({
  id,
  question: `¿${id}?`,
  options: ['sí', 'no'],
  status: 'open',
  ...extra,
});
const item = (id: string, phase: string): BoardItem => ({
  id,
  title: `Tarea ${id}`,
  phase,
  agentIds: [],
});

describe('owner inbox', () => {
  it('gathers every kind of pending item, most urgent first', () => {
    const entries = ownerInbox({
      blockers: [{ id: 'invalid', text: 'Configuración no válida' }],
      decisions: [
        decision('normal'),
        decision('urgent', { urgency: 'critical' }),
        decision('answered', { status: 'answered' }),
      ],
      agentsNeedingApproval: [{ id: 3, name: 'Claude' }],
      items: [
        item('SA-1', 'AWAITING_REVIEW'),
        item('SA-2', 'FAILED_FINAL'),
        item('SA-3', 'RUNNING'),
      ],
      meetingNeedsOwner: { topic: 'Arquitectura' },
    });
    expect(entries.map(({ kindLabel }) => kindLabel)).toEqual([
      'Bloqueo',
      'Decisión urgente',
      'Aprobación',
      'Decisión',
      'Tarea fallida',
      'Revisión',
      'Reunión',
    ]);
    expect(entries.find(({ id }) => id === 'agent:3')?.action).toEqual({
      kind: 'agent',
      agentId: 3,
    });
  });

  it('lists a task blocked by a decision once, through the decision', () => {
    const entries = ownerInbox({
      decisions: [decision('d1', { blocks: ['SA-9'] })],
      items: [item('SA-9', 'WAITING_HUMAN')],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toContain('SA-9');
  });

  it('is empty when nothing waits, and the tab title carries the count', () => {
    expect(ownerInbox({})).toEqual([]);
    expect(inboxTitle('SoftwareAgents', 0)).toBe('SoftwareAgents');
    expect(inboxTitle('SoftwareAgents', 3)).toBe('(3) SoftwareAgents');
  });
});
