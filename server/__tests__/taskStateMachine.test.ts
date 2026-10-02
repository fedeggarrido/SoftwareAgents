import { describe, expect, it } from 'vitest';

import {
  canStart,
  canTransition,
  TASK_TRANSITIONS,
  type TaskStatus,
} from '../src/workstore/taskStateMachine.js';

// Independent specification: every pair, including self-transitions and terminal states.
const expected: Record<TaskStatus, string> = {
  DRAFT: 'READY CANCELLED',
  READY: 'QUEUED BLOCKED WAITING_HUMAN WAITING_QUOTA CANCELLED',
  QUEUED: 'LEASED BLOCKED WAITING_HUMAN WAITING_QUOTA CANCELLED',
  LEASED: 'RUNNING FAILED_RETRYABLE FAILED_FINAL WAITING_QUOTA CANCELLED',
  RUNNING: 'REVIEW BLOCKED FAILED_RETRYABLE FAILED_FINAL WAITING_HUMAN WAITING_QUOTA CANCELLED',
  REVIEW: 'QA RUNNING BLOCKED FAILED_FINAL WAITING_HUMAN CANCELLED',
  QA: 'DONE RUNNING BLOCKED FAILED_FINAL WAITING_HUMAN CANCELLED',
  BLOCKED: 'READY FAILED_FINAL CANCELLED',
  FAILED_RETRYABLE: 'READY FAILED_FINAL CANCELLED',
  WAITING_HUMAN: 'READY FAILED_FINAL CANCELLED',
  WAITING_QUOTA: 'READY CANCELLED',
  DONE: '',
  FAILED_FINAL: '',
  CANCELLED: '',
};
describe('Task state machine', () => {
  const states = Object.keys(expected) as TaskStatus[];
  it.each(
    states.flatMap((from) =>
      states.map((to) => ({ from, to, allowed: expected[from].split(' ').includes(to) })),
    ),
  )('$from → $to = $allowed', ({ from, to, allowed }) => {
    expect(canTransition(from, to)).toBe(allowed);
  });
  it('covers exactly the canonical states', () => {
    expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual(states.sort());
  });
  it('requires all dependencies DONE and fails closed for missing dependencies', () => {
    expect(canStart({ dependencies: [] })).toBe(true);
    expect(canStart({ dependencies: [{ status: 'DONE' }, { status: 'DONE' }] })).toBe(true);
    expect(canStart({ dependencies: [{ status: 'DONE' }, undefined] })).toBe(false);
    for (const status of states.filter((s) => s !== 'DONE'))
      expect(canStart({ dependencies: [{ status }] })).toBe(false);
  });
});
