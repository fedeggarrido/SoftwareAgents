import { useEffect, useState } from 'react';

import { AGENT_LIST_REFRESH_MS } from '../constants.js';
import { useBoard } from '../office/boardStore.js';
import { characterDisplayName } from '../office/characterActivity.js';
import { criticalBlockers } from '../office/criticalBlockers.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { useExecutorStore } from '../office/executorStore.js';
import { meetingPresentation } from '../office/meetingPresentation.js';
import type { InboxEntry } from '../office/ownerInbox.js';
import { ownerInbox } from '../office/ownerInbox.js';
import { getAgentRole, getProviderLabel } from '../office/toolUtils.js';

type Approval = { id: number; name: string };

/** Agents waiting for a permission answer; a sub-agent's ask is listed on its parent. */
function approvalsOf(officeState: OfficeState): Approval[] {
  const ids = new Set<number>();
  for (const ch of officeState.getCharacters()) {
    if (ch.bubbleType !== 'permission') continue;
    const id = ch.isSubagent ? ch.parentAgentId : ch.id;
    if (id !== null && id > 0) ids.add(id);
  }
  return [...ids]
    .sort((a, b) => a - b)
    .map((id) => {
      const ch = officeState.characters.get(id);
      const name = ch
        ? characterDisplayName(ch, getAgentRole(id)?.label, getProviderLabel(id))
        : String(id);
      return { id, name };
    });
}

/** Samples the office like the agent list, but re-renders only when the asks change. */
function useApprovals(officeState: OfficeState): Approval[] {
  const [approvals, setApprovals] = useState<Approval[]>(() => approvalsOf(officeState));
  useEffect(() => {
    const timer = setInterval(() => {
      const next = approvalsOf(officeState);
      setApprovals((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    }, AGENT_LIST_REFRESH_MS);
    return () => clearInterval(timer);
  }, [officeState]);
  return approvals;
}

/** The owner's inbox from the live stores. */
export function useOwnerInbox(officeState: OfficeState): InboxEntry[] {
  const board = useBoard();
  const executors = useExecutorStore().state;
  const approvals = useApprovals(officeState);
  const meeting = board?.meeting;
  const meetingView = meeting ? meetingPresentation(meeting, board?.decisions) : null;
  return ownerInbox({
    decisions: board?.decisions,
    items: board?.items,
    blockers: criticalBlockers(executors),
    agentsNeedingApproval: approvals,
    // A meeting waiting on a decision is already listed through that decision.
    meetingNeedsOwner:
      meeting && meetingView?.needsOwner && !meetingView.decision ? { topic: meeting.topic } : null,
  });
}
