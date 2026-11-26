import { useEffect, useRef, useState } from 'react';

import { AGENT_LIST_REFRESH_MS } from '../constants.js';
import { es } from '../i18n/es.js';
import {
  characterActivity,
  characterActivityLabel,
  characterDisplayName,
} from '../office/characterActivity.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { getAgentRole, getProviderLabel } from '../office/toolUtils.js';
import type { ToolActivity } from '../office/types.js';

/** The card mounts with the next office render; give it a few frames. */
const CARD_FOCUS_FRAMES = 10;
function focusCardTitle(framesLeft: number): void {
  const title = document.querySelector<HTMLElement>('.agent-card');
  if (title) title.focus();
  else if (framesLeft > 0) requestAnimationFrame(() => focusCardTitle(framesLeft - 1));
}

interface AgentListProps {
  officeState: OfficeState;
  agentTools: Record<number, ToolActivity[]>;
}

/** The canvas as a keyboard and screen reader list: same agents, same states, same card. */
export function AgentList({ officeState, agentTools }: AgentListProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), AGENT_LIST_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const rows = officeState
    .getCharacters()
    .filter((ch) => ch.id > 0 && !ch.isSubagent && ch.matrixEffect !== 'despawn')
    .map((ch) => {
      const role = getAgentRole(ch.id);
      return {
        id: ch.id,
        name: characterDisplayName(ch, role?.label, getProviderLabel(ch.id)),
        activity: characterActivityLabel(ch, agentTools[ch.id]),
        needsYou: characterActivity(ch) === 'needs_you',
      };
    });

  // Announce only arrivals: a list that repeats itself every second is noise.
  const needing = useRef(new Set<number>());
  const [announcement, setAnnouncement] = useState({ text: '', count: 0 });
  const arrivals = rows.filter((row) => row.needsYou && !needing.current.has(row.id));
  const arrivalText = arrivals.map((row) => row.name).join(', ');
  const needIds = rows.filter((row) => row.needsYou).map((row) => row.id);
  const needKey = needIds.join(',');
  useEffect(() => {
    needing.current = new Set(needKey ? needKey.split(',').map(Number) : []);
    // The counter alters the text, so a repeated need is read again.
    if (arrivalText)
      setAnnouncement((prev) => ({
        text: es.agentList.needsYou(arrivalText),
        count: prev.count + 1,
      }));
  }, [needKey, arrivalText]);

  // The card opened from here gets the focus, and gives it back when it closes.
  const openedFrom = useRef<number | null>(null);
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  useEffect(() => {
    const id = openedFrom.current;
    if (id === null || officeState.selectedAgentId === id) return;
    openedFrom.current = null;
    buttons.current.get(id)?.focus();
  });

  return (
    <section className="agent-list" aria-labelledby="agent-list-title">
      <h2 id="agent-list-title">{es.agentList.title}</h2>
      {rows.length === 0 ? (
        <p>{es.agentList.empty}</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                ref={(el) => {
                  if (el) buttons.current.set(row.id, el);
                  else buttons.current.delete(row.id);
                }}
                aria-pressed={officeState.selectedAgentId === row.id}
                onClick={() => {
                  officeState.selectedAgentId = row.id;
                  officeState.cameraFollowId = null;
                  openedFrom.current = row.id;
                  focusCardTitle(CARD_FOCUS_FRAMES);
                }}
              >
                {es.agentList.row(row.name, row.activity)}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="sr-only" aria-live="polite">
        {announcement.text + (announcement.count % 2 ? '​' : '')}
      </p>
    </section>
  );
}
