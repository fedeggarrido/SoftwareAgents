import { describe, expect, it } from 'vitest';

import type {
  DomainEventPayload,
  WorkSnapshot,
  WorkTask,
  WorkTaskStatus,
} from '../../core/src/messages.js';
import { createCharacter, updateCharacter } from '../src/office/engine/characters.js';
import { WORK_STATE_SPRITES } from '../src/office/sprites/spriteData.js';
import { CharacterState } from '../src/office/types.js';
import { deriveWorkStates, type WorkCharacter } from '../src/office/workState.js';

const character: WorkCharacter[] = [{ id: 1, detail: 'tarea SA-048' }];
const task: WorkTask = {
  key: 'SA-048',
  type: 'IMPLEMENTATION',
  status: 'RUNNING',
  priority: 1,
  agentRole: 'developer',
  featureKey: null,
  version: 1,
  attempt: 1,
  dependsOn: [],
  updatedAt: 1,
};
function snapshot(patch: Partial<WorkTask> = {}): WorkSnapshot {
  return {
    type: 'workSnapshot',
    projectId: 'project',
    source: 'ok',
    lastEventId: 10,
    tasks: [{ ...task, ...patch }],
    decisions: [],
    generatedAt: 1,
  };
}
function event(patch: Partial<DomainEventPayload> = {}): DomainEventPayload {
  return {
    eventId: 11,
    kind: 'task.state_changed',
    projectId: 'project',
    taskKey: task.key,
    agentRole: 'developer',
    executionId: null,
    at: 2,
    ...patch,
  };
}
function state(s = snapshot(), events: DomainEventPayload[] = [], chars = character) {
  return deriveWorkStates(s, events, chars).get(1);
}

describe('domain character work states', () => {
  it.each<[WorkTaskStatus, string]>([
    ['RUNNING', 'CODING'],
    ['REVIEW', 'REVIEWING'],
    ['QA', 'TESTING'],
    ['WAITING_QUOTA', 'WAITING_QUOTA'],
    ['BLOCKED', 'BLOCKED'],
    ['WAITING_HUMAN', 'WAITING_HUMAN'],
    ['FAILED_FINAL', 'FAILED'],
    ['FAILED_RETRYABLE', 'FAILED'],
    ['DONE', 'AVAILABLE'],
    ['CANCELLED', 'AVAILABLE'],
  ])('projects snapshot and transition %s as %s', (status, expected) => {
    expect(state(snapshot({ status }))).toBe(expected);
    expect(state(snapshot(), [event({ toStatus: status })])).toBe(expected);
  });
  it('plans design and requirements work', () => {
    for (const type of ['architecture', 'design', 'spec', 'spike'])
      expect(state(snapshot({ type }))).toBe('PLANNING');
    expect(state(snapshot({ type: 'docs', agentRole: 'requirements-analyst' }))).toBe('PLANNING');
    expect(state(snapshot({ type: 'review' }))).toBe('REVIEWING');
    expect(state(snapshot({ type: 'qa' }))).toBe('TESTING');
  });
  it('waits on known unfinished dependencies', () => {
    const s = snapshot({ status: 'READY', dependsOn: ['dependency'] });
    s.tasks.push({ ...task, key: 'dependency', status: 'RUNNING' });
    expect(state(s)).toBe('WAITING_DEPENDENCY');
    expect(state(s, [event({ taskKey: 'dependency', toStatus: 'DONE' })])).toBe('AVAILABLE');
  });
  it('discards old, foreign and stale-version events without mutating input', () => {
    const s = snapshot();
    expect(
      state(s, [
        event({ eventId: 10, toStatus: 'FAILED_FINAL' }),
        event({ eventId: 9, toStatus: 'BLOCKED' }),
        event({ projectId: 'other', toStatus: 'QA' }),
        event({ taskVersion: 0, toStatus: 'REVIEW' }),
      ]),
    ).toBe('CODING');
    expect(s.tasks[0].status).toBe('RUNNING');
  });
  it('requires an exact recorded task association in the same Project', () => {
    expect(state(snapshot(), [], [{ id: 1, detail: 'developer' }])).toBe('AVAILABLE');
    expect(state(snapshot(), [], [{ id: 1, detail: 'tarea missing' }])).toBe('AVAILABLE');
    expect(state(snapshot(), [], [{ ...character[0], projectId: 'other' }])).toBe('AVAILABLE');
    expect(state(snapshot(), [], [{ ...character[0], projectId: 'project' }])).toBe('CODING');
    expect(state({ ...snapshot(), source: 'unreadable' })).toBe('AVAILABLE');
    expect(deriveWorkStates(null, [], character).get(1)).toBe('AVAILABLE');
  });
  it('gives a shared task to the newest Session only (Developer, then Reviewer)', () => {
    const both = deriveWorkStates(
      snapshot({ status: 'REVIEW' }),
      [],
      [...character, { id: 2, detail: 'tarea SA-048' }],
    );
    expect(both.get(1)).toBe('AVAILABLE');
    expect(both.get(2)).toBe('REVIEWING');
  });
  it('applies events after a missing (empty) WorkStore snapshot', () => {
    const empty = { ...snapshot(), source: 'missing' as const, tasks: [], lastEventId: null };
    expect(state(empty, [event({ toStatus: 'RUNNING' })])).toBe('CODING');
  });
  it('enters and leaves human wait in event order', () => {
    const required = event({ kind: 'human.decision.required' });
    expect(state(snapshot(), [required])).toBe('WAITING_HUMAN');
    expect(
      state(snapshot(), [
        event({ eventId: 12, kind: 'human.decision.answered', toStatus: 'RUNNING' }),
        required,
      ]),
    ).toBe('CODING');
    expect(
      state(snapshot(), [required, event({ eventId: 12, kind: 'human.decision.answered' })]),
    ).toBe('AVAILABLE');
  });
  it('handles semantic notices without transition payload', () => {
    for (const [kind, expected] of [
      ['quota.waiting', 'WAITING_QUOTA'],
      ['review.requested', 'REVIEWING'],
      ['qa.requested', 'TESTING'],
    ] as const)
      expect(state(snapshot(), [event({ kind })])).toBe(expected);
  });
  it('provides ten distinct bubble shapes', () => {
    expect(
      new Set(Object.values(WORK_STATE_SPRITES).map((sprite) => JSON.stringify(sprite))).size,
    ).toBe(10);
  });
  it('projects newly observed tasks and retains semantic notices sharing an event id', () => {
    const s = { ...snapshot(), tasks: [] };
    expect(state(s, [event({ kind: 'quota.waiting' })])).toBe('WAITING_QUOTA');
    expect(state(s, [event({ kind: 'execution.started', agentRole: 'architect' })])).toBe(
      'PLANNING',
    );
    expect(
      state(s, [event({ toStatus: 'WAITING_HUMAN' }), event({ kind: 'human.decision.required' })]),
    ).toBe('WAITING_HUMAN');
    expect(state(snapshot(), [event({ kind: 'execution.finished' })])).toBe('AVAILABLE');
  });
  it('keeps domain work seated between legacy turns', () => {
    const ch = createCharacter(1, 0, null, null);
    ch.state = CharacterState.TYPE;
    ch.isActive = false;
    ch.hasDomainWork = true;
    updateCharacter(ch, 100, [], new Map(), [], new Set());
    expect(ch.state).toBe(CharacterState.TYPE);
    ch.hasDomainWork = false;
    updateCharacter(ch, 1, [], new Map(), [], new Set());
    expect(ch.state).toBe(CharacterState.IDLE);
  });
});
