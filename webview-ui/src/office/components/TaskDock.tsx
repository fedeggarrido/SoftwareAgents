import { useEffect, useState } from 'react';

import { DEPARTMENT_COLORS, PHASE_COLORS } from '../../constants.js';
import type { BoardItem } from '../boardStore.js';
import { useBoard } from '../boardStore.js';
import type { OfficeState } from '../engine/officeState.js';
import { getAgentRole } from '../toolUtils.js';

/**
 * The company's delivery flow, in order. The percentage shown for a task is its
 * position in THIS flow (Desarrollo = 3 of 6 = 50 %), never an estimate of how
 * much of the work is done: nothing reports that truthfully.
 */
const FLOW: { phase: string; label: string }[] = [
  { phase: 'ANALYSIS', label: 'Análisis' },
  { phase: 'READY', label: 'Listo' },
  { phase: 'ACTIVE', label: 'Desarrollo' },
  { phase: 'AWAITING_REVIEW', label: 'Revisión' },
  { phase: 'VERIFIED', label: 'Verificada' },
  { phase: 'DONE', label: 'Hecho' },
];

/** Phases worth a row in the dock even with nobody on them right now. */
const IN_FLIGHT = new Set(['READY', 'ACTIVE', 'AWAITING_REVIEW', 'VERIFIED']);

function flowStep(phase: string): number {
  return FLOW.findIndex((s) => s.phase === phase);
}

function TaskRow({
  item,
  officeState,
  onFocusAgent,
}: {
  item: BoardItem;
  officeState: OfficeState;
  onFocusAgent: (id: number) => void;
}) {
  const step = flowStep(item.phase);
  const blocked = item.phase === 'BLOCKED';
  const label = blocked ? 'Bloqueada' : (FLOW[step]?.label ?? item.phase);
  const pct = step >= 0 ? Math.round(((step + 1) / FLOW.length) * 100) : null;
  const color = PHASE_COLORS[item.phase] ?? PHASE_COLORS['?'];
  return (
    <div
      className="flex items-center gap-6 text-2xs leading-none whitespace-nowrap"
      title={`${item.id} — ${item.title}\nFase: ${label}${
        pct !== null ? ` (paso ${step + 1} de ${FLOW.length} del flujo)` : ''
      }${item.owner ? `\nReserva: ${item.owner.worker} · ${item.owner.session}` : ''}${
        item.note ? `\n${item.note}` : ''
      }`}
      data-testid="task-row"
    >
      <span style={{ color }} className="w-80">
        {item.id}
      </span>
      <span className="w-160 overflow-hidden text-ellipsis">{item.title}</span>
      <span className="flex gap-1">
        {FLOW.map((s, i) => (
          <span
            key={s.phase}
            className="h-6 w-10 border border-border"
            style={{ background: !blocked && i <= step ? color : undefined }}
          />
        ))}
      </span>
      <span className="w-110" style={{ color }}>
        {label}
        {pct !== null && !blocked ? ` · ${pct}%` : ''}
      </span>
      <span className="flex gap-3">
        {item.agentIds.length === 0 && item.owner && (
          <span
            className="text-text-muted"
            title="Reservada, pero su sesión aún no está en la oficina"
          >
            ○ {item.owner.worker}
          </span>
        )}
        {item.agentIds.map((id) => {
          const role = getAgentRole(id);
          const busy = officeState.characters.get(id)?.isActive ?? false;
          return (
            <button
              key={id}
              className="cursor-pointer"
              style={{
                color: role ? DEPARTMENT_COLORS[role.department] : undefined,
                opacity: busy ? 1 : 0.5,
              }}
              onClick={() => onFocusAgent(id)}
              title={`${role?.label ?? `Agente #${id}`} · ${busy ? 'trabajando ahora' : 'sin actividad ahora'} · ver en la oficina`}
            >
              {busy ? '●' : '○'} {role?.label ?? `#${id}`}
            </button>
          );
        })}
      </span>
    </div>
  );
}

interface TaskDockProps {
  officeState: OfficeState;
  onFocusAgent: (id: number) => void;
}

/**
 * Bottom-right dock, one line per task being worked on (or in flight). Folds to a
 * single button so it never covers the office; starts folded on narrow screens.
 */
export function TaskDock({ officeState, onFocusAgent }: TaskDockProps) {
  const board = useBoard();
  const [open, setOpen] = useState(false);
  // Re-render periodically so busy/idle markers follow the characters.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!board) return null;
  const busy = (i: BoardItem) =>
    i.agentIds.some((id) => officeState.characters.get(id)?.isActive ?? false);
  // Finished tasks leave the dock once nobody is working on them anymore.
  const tasks = board.items.filter((i) =>
    i.phase === 'DONE' ? busy(i) : i.agentIds.length > 0 || IN_FLIGHT.has(i.phase),
  );
  if (tasks.length === 0) return null;
  return (
    <div
      className="absolute bottom-10 right-10 z-20 pixel-panel px-8 py-4 flex flex-col gap-4 max-w-[70vw] max-h-[32vh] overflow-auto"
      data-testid="task-dock"
    >
      <button className="cursor-pointer text-left text-xs" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} Tareas en seguimiento ({tasks.length})
      </button>
      {open &&
        tasks.map((item) => (
          <TaskRow
            key={item.id}
            item={item}
            officeState={officeState}
            onFocusAgent={onFocusAgent}
          />
        ))}
    </div>
  );
}
