import type { BoardDecision, MeetingState } from '../../../core/src/messages.js';
import { es } from '../i18n/es.js';

const copy = es.meeting;

const STATUS_CHIPS: Readonly<Record<string, string>> = {
  running: 'meeting',
  waiting_quota: 'WAITING_QUOTA',
  decided: 'meeting_decided',
  escalated: 'meeting_escalated',
};

const NO_DECISION_TEXT: Readonly<Record<string, string>> = {
  running: copy.running,
  waiting_quota: copy.waitingQuota,
  decided: copy.decided,
  escalated: copy.escalated,
};

function labelOf(labels: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(labels, key) ? labels[key] : undefined;
}

export function meetingRoundLabel(round: string): string {
  return labelOf(copy.rounds, round) ?? copy.unknownRound;
}

/** What a meeting is about, where it stands and whether it needs the owner. */
export function meetingPresentation(
  meeting: MeetingState,
  decisions: readonly BoardDecision[] = [],
) {
  const ongoing = meeting.status === 'running' || meeting.status === 'waiting_quota';
  // Meetings carry no decision id: the shared task is the only recorded link.
  const decision = decisions.find(
    ({ status, blocks }) => status === 'open' && !!meeting.task && blocks?.includes(meeting.task),
  );
  return {
    chip: labelOf(STATUS_CHIPS, meeting.status) ?? 'unknown',
    format: labelOf(copy.formats, meeting.format),
    // The board only carries the latest lines, so this is not a total of rounds.
    rounds: [...new Set([...meeting.lines.map(({ round }) => round), meeting.round])].map(
      (round) => ({
        label: meetingRoundLabel(round),
        current: ongoing && round === meeting.round,
      }),
    ),
    decision,
    intervention: decision
      ? copy.sameTaskDecision
      : (labelOf(NO_DECISION_TEXT, meeting.status) ?? copy.unknownStatus),
  };
}
