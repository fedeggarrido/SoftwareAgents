/**
 * SA-152: the Trabajo panel groups tasks by what they ask of the human, not by
 * raw phase. One table maps every phase to a group, so a new phase lands in
 * «Pendientes» until someone places it on purpose.
 */

export const BACKLOG_GROUPS = [
  { id: 'needsYou', label: 'Te necesitan' },
  { id: 'inProgress', label: 'En curso' },
  { id: 'pending', label: 'Pendientes' },
  { id: 'done', label: 'Hechas' },
] as const;
export type BacklogGroupId = (typeof BACKLOG_GROUPS)[number]['id'];

const GROUP_OF_PHASE: Readonly<Record<string, BacklogGroupId>> = {
  WAITING_HUMAN: 'needsYou',
  AWAITING_REVIEW: 'needsYou',
  FAILED_FINAL: 'needsYou',
  RUNNING: 'inProgress',
  LEASED: 'inProgress',
  ACTIVE: 'inProgress',
  REVIEW: 'inProgress',
  QA: 'inProgress',
  VERIFIED: 'done',
  DONE: 'done',
  CANCELLED: 'done',
};

/** Phases that are stuck without the human being the next step. */
const BLOCKED_PHASES: ReadonlySet<string> = new Set([
  'BLOCKED',
  'WAITING_QUOTA',
  'FAILED_RETRYABLE',
]);

export function backlogGroupOf(phase: string): BacklogGroupId {
  return GROUP_OF_PHASE[phase] ?? 'pending';
}

export interface BacklogPulse {
  working: number;
  needsYou: number;
  blocked: number;
}

/** The three numbers of the top strip: is anything waiting for me? */
export function backlogPulse(phases: readonly string[]): BacklogPulse {
  return {
    working: phases.filter((p) => backlogGroupOf(p) === 'inProgress').length,
    needsYou: phases.filter((p) => backlogGroupOf(p) === 'needsYou').length,
    blocked: phases.filter((p) => BLOCKED_PHASES.has(p)).length,
  };
}

/** Group items in the fixed group order, keeping the incoming order inside each group. */
export function groupBacklog<T extends { phase: string }>(
  items: readonly T[],
): { id: BacklogGroupId; label: string; items: T[] }[] {
  return BACKLOG_GROUPS.map((g) => ({
    ...g,
    items: items.filter((i) => backlogGroupOf(i.phase) === g.id),
  }));
}
