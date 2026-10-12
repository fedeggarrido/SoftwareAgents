import type { DomainEventKind, DomainEventPayload, WorkTaskStatus } from './messages.js';

/**
 * Work domain events the office receives as live notices (SA-029).
 *
 * Every event names the Project, the Task, the role and the Execution it
 * concerns, and when the WorkStore recorded it. `eventId` is the id of the
 * append-only `domain_events` row it was derived from; one row may yield
 * several kinds (a transition is always `task.state_changed`, plus the
 * semantic kind it implies), so `(eventId, kind)` identifies a notice.
 *
 * Notices are not a durable stream: state comes from `workSnapshot` on
 * connect, events only say that something changed since.
 */
export const DOMAIN_EVENT_KINDS = [
  'task.created',
  'task.state_changed',
  'task.leased',
  'execution.started',
  'execution.finished',
  'review.requested',
  'qa.requested',
  'quota.waiting',
  'quota.exhausted',
  'human.decision.required',
  'human.decision.answered',
] as const satisfies readonly DomainEventKind[];

interface DomainEventBase {
  eventId: number;
  projectId: string;
  taskKey: string;
  /** Role recorded on the Task; null when the WorkStore has none. */
  agentRole: string | null;
  /** Execution in effect, when the WorkStore records one; never guessed. */
  executionId: string | null;
  /** Epoch milliseconds. */
  at: number;
}

/** Fields every event derived from a Task transition carries. */
interface TransitionFields {
  fromStatus: WorkTaskStatus;
  toStatus: WorkTaskStatus;
  taskVersion: number;
  attempt: number;
}

type TransitionKind =
  | 'task.state_changed'
  | 'task.leased'
  | 'execution.started'
  | 'execution.finished'
  | 'review.requested'
  | 'qa.requested'
  | 'quota.waiting';

export type TransitionDomainEvent = {
  [K in TransitionKind]: DomainEventBase & TransitionFields & { kind: K };
}[TransitionKind];

export interface HumanDecisionDomainEvent extends DomainEventBase, TransitionFields {
  kind: 'human.decision.required' | 'human.decision.answered';
  /** The decision the log names; null when the transition names none. */
  decisionId: string | null;
}

/** Kinds no WorkStore writer records yet; defined so producers and clients share one catalog. */
export interface PendingDomainEvent extends DomainEventBase {
  kind: 'task.created' | 'quota.exhausted';
}

export type DomainEvent = TransitionDomainEvent | HumanDecisionDomainEvent | PendingDomainEvent;

export function isDomainEventKind(value: unknown): value is DomainEventKind {
  return (DOMAIN_EVENT_KINDS as readonly unknown[]).includes(value);
}

// Lockstep with the generated wire type: every DomainEvent is a valid payload,
// and the catalog covers every kind the contract declares.
type Assert<T extends true> = T;
export type _DomainEventMatchesWire = Assert<DomainEvent extends DomainEventPayload ? true : false>;
export type _DomainEventKindsComplete = Assert<
  DomainEventKind extends (typeof DOMAIN_EVENT_KINDS)[number] ? true : false
>;
