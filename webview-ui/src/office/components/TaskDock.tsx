import { useEffect, useState } from 'react';

import { DEPARTMENT_COLORS, PHASE_COLORS } from '../../constants.js';
import type { BoardItem } from '../boardStore.js';
import { useBoard } from '../boardStore.js';
import type { OfficeState } from '../engine/officeState.js';
import { getAgentRole } from '../toolUtils.js';

/**
 * The company's delivery flow, in order. The percentage shown for a task is its
 * position in THIS flow (Desarrollo = 3 of 5 = 60 %), never an estimate of how
 * much of the work is done: nothing reports that truthfully.
 */
const FLOW: { phase: string; label: string }[] = [
  { phase: 'ANALYSIS', label: 'Análisis' },
  { phase: 'READY', label: 'Listo' },
  { phase: 'ACTIVE', label: 'Desarrollo' },
  { phase: 'AWAITING_REVIEW', label: 'Revisión' },
  { phase: 'DONE', label: 'Hecho' },
];

/** Phases worth a card in the dock even with nobody on them right now. */
const IN_FLIGHT = new Set(['READY', 'ACTIVE', 'AWAITING_REVIEW']);

function flowStep(phase: string): number {
  if (phase === 'VERIFIED') return FLOW.length - 1;
  return FLOW.findIndex((s) => s.phase === phase);
}

function TaskCard({
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
      className="pixel-panel px-8 pt-4 pb-6 flex flex-col gap-4 w-300"
      title={`${item.id} — ${item.title}\nFase: ${label}${
        pct !== null ? ` (paso ${step + 1} de ${FLOW.length} del flujo)` : ''
      }${item.note ? `\n${item.note}` : ''}`}
      data-testid="task-card"
    >
      <div className="text-2xs leading-tight overflow-hidden text-ellipsis whitespace-nowrap">
        <span style={{ color }}>{item.id}</span> {item.title}
      </div>
      <div className="flex items-center gap-6">
        <div className="flex gap-2">
          {FLOW.map((s, i) => (
            <span
              key={s.phase}
              className="h-8 w-22 border border-border"
              style={{ background: !blocked && i <= step ? color : undefined }}
            />
          ))}
        </div>
        <span className="text-2xs leading-none whitespace-nowrap" style={{ color }}>
          {label}
          {pct !== null && !blocked ? ` · ${pct}%` : ''}
        </span>
      </div>
      <div className="flex gap-4 flex-wrap">
        {item.agentIds.length === 0 && (
          <span
            className="text-2xs text-text-muted"
            title={
              item.owner
                ? 'La tarea está reservada, pero su sesión aún no está en la oficina: aparece en cuanto vuelva a escribir en su transcript (p. ej. tras reiniciar la oficina o mientras genera una respuesta larga).'
                : undefined
            }
          >
            {item.owner
              ? `○ ${item.owner.worker} · ${item.owner.session} · aún no visible en la oficina`
              : 'Sin agente asignado'}
          </span>
        )}
        {item.agentIds.map((id) => {
          const role = getAgentRole(id);
          const busy = officeState.characters.get(id)?.isActive ?? false;
          return (
            <button
              key={id}
              className="text-2xs leading-none px-4 py-2 border border-border bg-bg-dark cursor-pointer"
              style={{
                color: role ? DEPARTMENT_COLORS[role.department] : undefined,
                opacity: busy ? 1 : 0.55,
              }}
              onClick={() => onFocusAgent(id)}
              title={
                busy
                  ? 'Trabajando ahora · ver en la oficina'
                  : 'Sin actividad ahora · ver en la oficina'
              }
            >
              {busy ? '● ' : '○ '}
              {role?.label ?? `Agente #${id}`}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface TaskDockProps {
  officeState: OfficeState;
  onFocusAgent: (id: number) => void;
}

/**
 * Bottom dock: one card per task being worked on (or in flight), never one per
 * character, so a task two agents touch shows once with both of them on it.
 */
export function TaskDock({ officeState, onFocusAgent }: TaskDockProps) {
  const board = useBoard();
  // Re-render periodically so busy/idle markers follow the characters.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!board) return null;
  const tasks = board.items.filter((i) => i.agentIds.length > 0 || IN_FLIGHT.has(i.phase));
  if (tasks.length === 0) return null;
  return (
    <div
      className="absolute bottom-10 left-1/2 -translate-x-1/2 z-20 flex gap-8 flex-wrap justify-center max-w-[70%]"
      data-testid="task-dock"
    >
      {tasks.map((item) => (
        <TaskCard key={item.id} item={item} officeState={officeState} onFocusAgent={onFocusAgent} />
      ))}
    </div>
  );
}
