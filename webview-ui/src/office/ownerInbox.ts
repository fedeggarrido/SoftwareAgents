import type { BoardDecision, BoardItem } from '../../../core/src/messages.js';
import { es } from '../i18n/es.js';
import { backlogGroupOf } from './backlogGroups.js';
import type { CriticalBlocker } from './criticalBlockers.js';

/**
 * SA-132: everything that waits for the owner, in one list ordered by urgency.
 * DOM-free: the panel, the dock badge and the tab title all read this.
 */

export type InboxAction =
  | { kind: 'decision'; decisionId: string }
  | { kind: 'task'; taskKey: string }
  | { kind: 'agent'; agentId: number }
  | { kind: 'meeting' }
  | { kind: 'none' };

export interface InboxEntry {
  id: string;
  /** Lower is more urgent. */
  rank: number;
  kindLabel: string;
  title: string;
  detail?: string;
  action: InboxAction;
}

export interface InboxSources {
  decisions?: readonly BoardDecision[];
  items?: readonly BoardItem[];
  agentsNeedingApproval?: ReadonlyArray<{ id: number; name: string }>;
  blockers?: readonly CriticalBlocker[];
  meetingNeedsOwner?: { topic: string } | null;
}

const RANK = {
  blocker: 0,
  urgentDecision: 1,
  approval: 2,
  decision: 3,
  failedTask: 4,
  task: 5,
  meeting: 6,
} as const;

export function ownerInbox(sources: InboxSources): InboxEntry[] {
  const copy = es.inbox;
  const entries: InboxEntry[] = [];
  for (const blocker of sources.blockers ?? [])
    entries.push({
      id: `blocker:${blocker.id}`,
      rank: RANK.blocker,
      kindLabel: copy.kinds.blocker,
      title: blocker.text,
      action: { kind: 'none' },
    });
  for (const decision of sources.decisions ?? []) {
    if (decision.status !== 'open') continue;
    const urgent = decision.urgency === 'high' || decision.urgency === 'critical';
    entries.push({
      id: `decision:${decision.id}`,
      rank: urgent ? RANK.urgentDecision : RANK.decision,
      kindLabel: urgent ? copy.kinds.urgentDecision : copy.kinds.decision,
      title: decision.question,
      detail: decision.blocks?.length ? copy.blocks(decision.blocks.join(', ')) : undefined,
      action: { kind: 'decision', decisionId: decision.id },
    });
  }
  for (const agent of sources.agentsNeedingApproval ?? [])
    entries.push({
      id: `agent:${agent.id}`,
      rank: RANK.approval,
      kindLabel: copy.kinds.approval,
      title: copy.approvalTitle(agent.name),
      detail: copy.approvalDetail,
      action: { kind: 'agent', agentId: agent.id },
    });
  // Tasks waiting for a decision are already listed through their decision.
  const decided = new Set(
    (sources.decisions ?? [])
      .filter((decision) => decision.status === 'open')
      .flatMap((decision) => decision.blocks ?? []),
  );
  for (const item of sources.items ?? []) {
    if (backlogGroupOf(item.phase) !== 'needsYou' || decided.has(item.id)) continue;
    const failed = item.phase === 'FAILED_FINAL';
    entries.push({
      id: `task:${item.id}`,
      rank: failed ? RANK.failedTask : RANK.task,
      kindLabel:
        copy.kinds[failed ? 'failedTask' : item.phase === 'AWAITING_REVIEW' ? 'review' : 'task'],
      title: `${item.id} · ${item.title}`,
      action: { kind: 'task', taskKey: item.id },
    });
  }
  if (sources.meetingNeedsOwner)
    entries.push({
      id: 'meeting',
      rank: RANK.meeting,
      kindLabel: copy.kinds.meeting,
      title: sources.meetingNeedsOwner.topic,
      action: { kind: 'meeting' },
    });
  return entries.sort((a, b) => a.rank - b.rank);
}

/** Browser tab title: the count is visible from another tab. */
export function inboxTitle(base: string, count: number): string {
  return count > 0 ? `(${count}) ${base}` : base;
}
