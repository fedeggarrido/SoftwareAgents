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
    .filter((ch) => ch.id > 0 && !ch.isSubagent)
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
  const [announcement, setAnnouncement] = useState('');
  const needKey = rows
    .filter((row) => row.needsYou)
    .map((row) => `${row.id}:${row.name}`)
    .join('|');
  useEffect(() => {
    const now = needKey ? needKey.split('|').map((entry) => entry.split(':')) : [];
    const arrived = now.find(([id]) => !needing.current.has(Number(id)));
    needing.current = new Set(now.map(([id]) => Number(id)));
    if (arrived) setAnnouncement(es.agentList.needsYou(arrived.slice(1).join(':')));
  }, [needKey]);
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
                aria-pressed={officeState.selectedAgentId === row.id}
                onClick={() => {
                  officeState.selectedAgentId = row.id;
                  officeState.cameraFollowId = null;
                }}
              >
                {row.name} · {row.activity}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </section>
  );
}
