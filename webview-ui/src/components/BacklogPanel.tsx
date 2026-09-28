import { useEffect, useState } from 'react';

import { PHASE_COLORS, PHASE_ORDER, PRIORITY_COLORS } from '../constants.js';
import type { BoardEvent, BoardItem } from '../office/boardStore.js';
import { useBoard } from '../office/boardStore.js';
import { Button } from './ui/Button.js';

const PHASE_LABELS: Record<string, string> = {
  ACTIVE: 'En curso',
  AWAITING_REVIEW: 'En revisión',
  READY: 'Listo',
  ANALYSIS: 'Análisis',
  BLOCKED: 'Bloqueado',
  VERIFIED: 'Verificado',
  DONE: 'Hecho',
};

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}min`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function EventLine({ e, now }: { e: BoardEvent; now: number }) {
  return (
    <div className="text-2xs leading-tight text-text-muted">
      <span className="text-text">{e.session}</span> · {e.phase} {e.state} · {ago(e.at, now)}
      <div className="overflow-hidden text-ellipsis whitespace-nowrap" title={e.detail}>
        {e.detail}
      </div>
    </div>
  );
}

function Card({
  item,
  now,
  onFocusAgent,
}: {
  item: BoardItem;
  now: number;
  onFocusAgent: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="bg-bg-dark border-2 border-border p-6 flex flex-col gap-2 cursor-pointer"
      style={{ borderLeftColor: PRIORITY_COLORS[item.priority ?? ''] ?? undefined }}
      onClick={() => setOpen((v) => !v)}
      data-testid="backlog-card"
    >
      <div className="flex items-baseline gap-6">
        <span className="text-2xs text-text-muted whitespace-nowrap">{item.id}</span>
        <span className="text-xs leading-tight">{item.title}</span>
      </div>
      {item.owner && (
        <div
          className="text-2xs"
          style={{ color: item.owner.stale ? PHASE_COLORS.BLOCKED : undefined }}
        >
          {item.owner.worker} · {item.owner.session}
          {item.owner.stale ? ' · sin latido' : ''}
        </div>
      )}
      {item.agentIds.length > 0 && (
        <div className="flex gap-4 flex-wrap">
          {item.agentIds.map((id) => (
            <Button
              key={id}
              size="sm"
              variant="active"
              onClick={(ev) => {
                ev.stopPropagation();
                onFocusAgent(id);
              }}
              title="Ver al agente en la oficina"
            >
              Ver agente #{id}
            </Button>
          ))}
        </div>
      )}
      {item.lastEvent && <EventLine e={item.lastEvent} now={now} />}
      {open && (
        <div className="text-2xs text-text-muted leading-tight flex flex-col gap-1">
          {item.epic && <div>{item.epic}</div>}
          <div>
            Prioridad {item.priority ?? '—'} · tamaño {item.size ?? '—'}
            {item.clickupId ? ` · ClickUp ${item.clickupId}` : ''}
          </div>
          {item.implementer && <div>Implementa: {item.implementer}</div>}
          {item.dependsOn && item.dependsOn.length > 0 && (
            <div>Depende de: {item.dependsOn.join(', ')}</div>
          )}
          {item.note && <div className="text-text">{item.note}</div>}
        </div>
      )}
    </div>
  );
}

interface BacklogPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onFocusAgent: (id: number) => void;
}

/** The company's backlog next to the office: phases, owners and last reports. */
export function BacklogPanel({ isOpen, onClose, onFocusAgent }: BacklogPanelProps) {
  const board = useBoard();
  const [now, setNow] = useState(() => Date.now());
  const [showDone, setShowDone] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [isOpen]);

  if (!isOpen) return null;

  const groups = PHASE_ORDER.map((phase) => ({
    phase,
    items: (board?.items ?? []).filter((i) => i.phase === phase),
  })).filter(
    (g) => g.items.length > 0 && (showDone || (g.phase !== 'DONE' && g.phase !== 'VERIFIED')),
  );
  const unknown = (board?.items ?? []).filter((i) => !PHASE_ORDER.includes(i.phase));

  return (
    <div
      className="absolute top-10 right-10 bottom-60 z-30 w-440 pixel-panel p-8 flex flex-col gap-8"
      data-testid="backlog-panel"
    >
      <div className="flex items-center gap-8">
        <span className="text-lg flex-1">Backlog {board ? `· ${board.project}` : ''}</span>
        <Button
          size="sm"
          variant={showDone ? 'active' : 'default'}
          onClick={() => setShowDone((v) => !v)}
        >
          Hechas
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose} title="Cerrar">
          ✕
        </Button>
      </div>

      {!board && (
        <div className="text-xs text-text-muted">
          Este workspace no tiene tablero (docs/backlog/board.json).
        </div>
      )}

      {board && (
        <>
          <div className="flex gap-6 flex-wrap text-2xs">
            {PHASE_ORDER.map((phase) => {
              const n = board.items.filter((i) => i.phase === phase).length;
              if (n === 0) return null;
              return (
                <span key={phase} style={{ color: PHASE_COLORS[phase] }}>
                  {PHASE_LABELS[phase] ?? phase} {n}
                </span>
              );
            })}
          </div>
          <div className="text-2xs text-text-muted">
            Manager:{' '}
            {board.manager
              ? `${board.manager.session}${board.manager.stale ? ' (sin latido)' : ''}`
              : 'sin ronda activa'}
            {!board.sources.claims && ' · reservas no disponibles'}
            {!board.sources.progress && ' · sin registro de progreso'}
          </div>

          <div className="flex-1 overflow-y-auto flex flex-col gap-8 pr-4">
            {[...groups, ...(unknown.length ? [{ phase: '?', items: unknown }] : [])].map((g) => (
              <div key={g.phase} className="flex flex-col gap-4">
                <div className="text-sm" style={{ color: PHASE_COLORS[g.phase] }}>
                  {PHASE_LABELS[g.phase] ?? g.phase} · {g.items.length}
                </div>
                {g.items.map((item) => (
                  <Card key={item.id} item={item} now={now} onFocusAgent={onFocusAgent} />
                ))}
              </div>
            ))}
          </div>

          {board.recent.length > 0 && (
            <div className="border-t-2 border-border pt-6 flex flex-col gap-4 max-h-200 overflow-y-auto">
              <div className="text-sm">Actividad reciente</div>
              {board.recent.slice(0, 6).map((e, i) => (
                <EventLine key={`${e.at}-${i}`} e={e} now={now} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
