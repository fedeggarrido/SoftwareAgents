import { useEffect, useState } from 'react';

import {
  CHARACTER_SITTING_OFFSET_PX,
  PHASE_COLORS,
  TASK_BADGE_OFFSET_PX,
} from '../../constants.js';
import type { BoardItem } from '../boardStore.js';
import { useBoard } from '../boardStore.js';
import type { OfficeState } from '../engine/officeState.js';
import { overlayProjection } from '../projection.js';
import { CharacterState } from '../types.js';

/**
 * The company's delivery flow, in order. The percentage shown under a character
 * is the task's position in THIS flow (Desarrollo = 3 of 5 = 60 %), never an
 * estimate of how much of the work is done: nothing reports that truthfully.
 */
const FLOW: { phase: string; label: string }[] = [
  { phase: 'ANALYSIS', label: 'Análisis' },
  { phase: 'READY', label: 'Listo' },
  { phase: 'ACTIVE', label: 'Desarrollo' },
  { phase: 'AWAITING_REVIEW', label: 'Revisión' },
  { phase: 'DONE', label: 'Hecho' },
];

function flowStep(phase: string): number {
  if (phase === 'VERIFIED') return FLOW.length - 1;
  return FLOW.findIndex((s) => s.phase === phase);
}

function Badge({ item }: { item: BoardItem }) {
  const step = flowStep(item.phase);
  const blocked = item.phase === 'BLOCKED';
  const label = blocked ? 'Bloqueada' : (FLOW[step]?.label ?? item.phase);
  const pct = step >= 0 ? Math.round(((step + 1) / FLOW.length) * 100) : null;
  const color = PHASE_COLORS[item.phase] ?? PHASE_COLORS['?'];
  return (
    <div
      className="pixel-panel px-6 pt-2 pb-4 flex flex-col gap-2 max-w-2xs"
      title={`${item.id} — ${item.title}\nFase: ${label}${pct !== null ? ` (paso ${step + 1} de ${FLOW.length} del flujo)` : ''}`}
      data-testid="task-badge"
    >
      <div className="text-2xs leading-none whitespace-nowrap overflow-hidden text-ellipsis">
        <span style={{ color }}>{item.id}</span> {item.title}
      </div>
      <div className="flex items-center gap-4">
        <div className="flex gap-1">
          {FLOW.map((s, i) => (
            <span
              key={s.phase}
              className="h-5 w-14 border border-border"
              style={{ background: !blocked && i <= step ? color : undefined }}
            />
          ))}
        </div>
        <span className="text-2xs leading-none whitespace-nowrap" style={{ color }}>
          {label}
          {pct !== null && !blocked ? ` · ${pct}%` : ''}
        </span>
      </div>
    </div>
  );
}

interface TaskBadgesProps {
  officeState: OfficeState;
  agents: number[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
}

/** Under each character working a backlog task: the task and where it is in the flow. */
export function TaskBadges({ officeState, agents, containerRef, zoom, panRef }: TaskBadgesProps) {
  const board = useBoard();
  const [, setTick] = useState(0);
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const el = containerRef.current;
  if (!el || !board) return null;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    window.devicePixelRatio || 1,
  );

  return (
    <>
      {agents.map((id) => {
        const item = board.items.find((i) => i.agentIds.includes(id));
        const ch = officeState.characters.get(id);
        if (!item || !ch) return null;
        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
        return (
          <div
            key={id}
            className="absolute -translate-x-1/2"
            style={{
              left: project.toScreenX(ch.x),
              top: project.toScreenY(ch.y + sittingOffset + TASK_BADGE_OFFSET_PX),
              pointerEvents: 'none',
              zIndex: 40,
            }}
          >
            <Badge item={item} />
          </div>
        );
      })}
    </>
  );
}
