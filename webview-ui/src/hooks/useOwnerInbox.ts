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

/** The owner's inbox from the live stores; agent approvals are sampled like the agent list. */
export function useOwnerInbox(officeState: OfficeState): InboxEntry[] {
  const board = useBoard();
  const executors = useExecutorStore().state;
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), AGENT_LIST_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const meeting = board?.meeting;
  const meetingView = meeting ? meetingPresentation(meeting, board?.decisions) : null;
  return ownerInbox({
    decisions: board?.decisions,
    items: board?.items,
    blockers: criticalBlockers(executors),
    agentsNeedingApproval: officeState
      .getCharacters()
      .filter((ch) => ch.id > 0 && ch.bubbleType === 'permission')
      .map((ch) => ({
        id: ch.id,
        name: characterDisplayName(ch, getAgentRole(ch.id)?.label, getProviderLabel(ch.id)),
      })),
    // A meeting waiting on a decision is already listed through that decision.
    meetingNeedsOwner:
      meeting && meetingView?.needsOwner && !meetingView.decision ? { topic: meeting.topic } : null,
  });
}
