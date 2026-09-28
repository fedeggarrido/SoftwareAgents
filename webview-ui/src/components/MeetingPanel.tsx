import { useState } from 'react';

import { DEPARTMENT_COLORS, QUOTA_COLORS } from '../constants.js';
import { useBoard } from '../office/boardStore.js';

const ROUND_LABELS: Record<string, string> = {
  borrador: 'Borradores independientes',
  critica: 'Crítica cruzada',
  premortem: 'Pre-mortem',
  'delphi-1': 'Delphi · ronda 1',
  'delphi-2': 'Delphi · ronda 2',
  decision: 'Decisión del juez',
};

const STATUS_LABELS: Record<string, string> = {
  running: 'en curso',
  waiting_quota: 'en espera de cuota',
  decided: 'decidida',
  escalated: 'escalada al propietario',
};

/** Rough department by role name, for coloring who speaks. */
function colorOf(role: string): string {
  if (role === 'company-manager') return DEPARTMENT_COLORS['Dirección'];
  if (/reviewer|testing|validation/.test(role)) return DEPARTMENT_COLORS['Calidad'];
  if (/analyst|strategist|challenger/.test(role)) return DEPARTMENT_COLORS['Análisis'];
  if (/design|ux/.test(role)) return DEPARTMENT_COLORS['Diseño'];
  return DEPARTMENT_COLORS['Ingeniería'];
}

/** What the agents are discussing in the meeting room, round by round. */
export function MeetingPanel() {
  const board = useBoard();
  const [open, setOpen] = useState(true);
  const m = board?.meeting;
  if (!m) return null;
  const status = STATUS_LABELS[m.status] ?? m.status;
  return (
    <div
      className="absolute top-80 left-10 z-20 pixel-panel p-8 flex flex-col gap-4 w-[min(360px,80vw)] max-h-[55vh] overflow-y-auto"
      data-testid="meeting-panel"
    >
      <button className="cursor-pointer text-left text-xs" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} Sala de reuniones · {status}
      </button>
      {open && (
        <>
          <div className="text-2xs leading-tight">
            <span className="text-text-muted">{m.format}</span> · {m.topic}
          </div>
          <div className="text-2xs text-text-muted leading-tight">{m.question}</div>
          {m.status === 'waiting_quota' && m.waitReason && (
            <div className="text-2xs" style={{ color: QUOTA_COLORS.rejected }}>
              ⏸ {m.waitReason}
            </div>
          )}
          {m.lines.map((l, i) => (
            <div key={`${l.at}-${i}`} className="text-2xs leading-tight">
              <div className="text-text-muted">{ROUND_LABELS[l.round] ?? l.round}</div>
              <span style={{ color: colorOf(l.role) }}>{l.role}</span>: {l.stance}
            </div>
          ))}
          {m.decision && (
            <div
              className="text-xs border-t-2 border-border pt-4"
              style={{ color: DEPARTMENT_COLORS['Dirección'] }}
            >
              Decisión: {m.decision}
            </div>
          )}
        </>
      )}
    </div>
  );
}
