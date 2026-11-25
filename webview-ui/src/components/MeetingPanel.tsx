import { useState } from 'react';

import { es } from '../i18n/es.js';
import { roleLabel } from '../i18n/roles.js';
import { useBoard } from '../office/boardStore.js';
import { meetingPresentation, meetingRoundLabel } from '../office/meetingPresentation.js';
import { StatusChip } from './StatusChip.js';
import { Button } from './ui/Button.js';

interface MeetingPanelProps {
  onOpenDecisions: () => void;
  /** Absent while no participant is in the physical room. */
  onShowRoom?: () => void;
}

/** What the agents are discussing in the meeting room, round by round. */
export function MeetingPanel({ onOpenDecisions, onShowRoom }: MeetingPanelProps) {
  const board = useBoard();
  const [open, setOpen] = useState(true);
  const m = board?.meeting;
  const copy = es.meeting;
  if (!m) return <p className="meeting-panel p-10">{copy.empty}</p>;
  const view = meetingPresentation(m, board.decisions);
  return (
    <div
      className="read-only-panel meeting-panel p-10 flex flex-col gap-8"
      data-testid="meeting-panel"
      role="region"
      aria-label="Reuniones"
    >
      <div className="flex flex-wrap items-center gap-8">
        <StatusChip state={view.chip} />
        {view.format && <span>{view.format}</span>}
      </div>
      <h3>{m.topic}</h3>
      <p>{m.question}</p>
      <section className="meeting-intervention" aria-label={copy.interventionTitle}>
        <p>
          <strong>{view.intervention}</strong>
        </p>
        {view.decision && (
          <>
            <p>{view.decision.question}</p>
            <Button variant="primary" onClick={onOpenDecisions}>
              {copy.openDecision}
            </Button>
          </>
        )}
        {m.status === 'waiting_quota' && m.waitReason && <p>{m.waitReason}</p>}
      </section>
      {m.decision && (
        <p>
          <strong>{copy.result}:</strong> {m.decision}
        </p>
      )}
      <section aria-label={copy.roundsTitle}>
        <h3>{copy.roundsTitle}</h3>
        <ol className="meeting-rounds">
          {view.rounds.map((round, index) => (
            <li key={index} aria-current={round.current ? 'step' : undefined}>
              {round.label}
              {round.current && ` (${copy.currentRound})`}
            </li>
          ))}
        </ol>
      </section>
      <div className="flex flex-wrap gap-8">
        {onShowRoom && <Button onClick={onShowRoom}>{copy.showRoom}</Button>}
        <Button aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? copy.hideDetails : copy.showDetails}
        </Button>
      </div>
      {open && (
        <ul className="meeting-lines">
          {m.lines.length === 0 && <li>{copy.noLines}</li>}
          {m.lines.map((line, index) => (
            <li key={`${line.at}-${index}`}>
              <strong>{roleLabel(line.role)}</strong> · {meetingRoundLabel(line.round)}
              <p>{line.stance}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
