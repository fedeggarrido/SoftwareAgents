import { useEffect, useRef, useState } from 'react';

import { PHASE_COLORS, PRIORITY_COLORS } from '../constants.js';
import { backlogPulse, groupBacklog } from '../office/backlogGroups.js';
import { backlogView } from '../office/backlogView.js';
import type { BoardEvent, BoardItem } from '../office/boardStore.js';
import { useBoard } from '../office/boardStore.js';
import { characterActivity } from '../office/characterActivity.js';
import { knownText } from '../office/displayText.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { taskPullRequestLabel } from '../office/prStatusView.js';
import { readableStateText, statusPresentation } from '../office/statusPresentation.js';
import { OfficeRecoveryActions } from './OfficeRecoveryActions.js';
import { StatusChip } from './StatusChip.js';
import { Button } from './ui/Button.js';
import { PanelHeading } from './ui/PanelHeading.js';

function workStatus(
  item: BoardItem,
  board: ReturnType<typeof useBoard>,
  office: OfficeState,
): string {
  if (item.phase === 'AWAITING_REVIEW') return 'esperando revisión';
  if (item.phase === 'VERIFIED') return 'verificada, pendiente de integrar';
  if (item.owner?.stale) return 'reserva sin latido';
  if (board?.waiting?.some((e) => e.session === item.owner?.session)) return 'esperando cuota';
  if (
    item.agentIds.some((id) => {
      const ch = office.characters.get(id);
      return ch && characterActivity(ch) === 'working';
    })
  )
    return 'trabajando ahora';
  if (item.owner?.state === 'active') return 'reservada, sin actividad visible';
  return statusPresentation(item.phase).label.toLowerCase();
}

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
      <StatusChip state={e.phase} /> · {ago(e.at, now)}
      <div
        className="overflow-hidden text-ellipsis whitespace-nowrap"
        title={readableStateText(e.detail)}
      >
        {readableStateText(e.detail)}
      </div>
    </div>
  );
}

/** Human title; the key only stands in when the task has no title of its own. */
function cardTitle(item: BoardItem): string {
  return knownText(item.title) ?? knownText(item.id) ?? item.id;
}

function Card({
  item,
  now,
  onFocusAgent,
  board,
  officeState,
  focused,
}: {
  item: BoardItem;
  now: number;
  onFocusAgent: (id: number) => void;
  board: ReturnType<typeof useBoard>;
  officeState: OfficeState;
  focused: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    ref.current?.scrollIntoView({ block: 'nearest' });
    ref.current?.focus({ preventScroll: true });
  }, [focused]);
  return (
    <div
      className="bg-bg-dark border-2 border-border p-6 flex flex-col gap-2 cursor-pointer"
      style={{ borderLeftColor: PRIORITY_COLORS[item.priority ?? ''] ?? undefined }}
      onClick={() => setOpen((v) => !v)}
      ref={ref}
      tabIndex={-1}
      data-task-key={item.id}
      data-testid="backlog-card"
    >
      <div className="text-sm leading-tight">{cardTitle(item)}</div>
      <div className="flex items-center gap-6 flex-wrap text-2xs text-text-muted">
        <StatusChip state={item.phase} />
        {cardTitle(item) !== knownText(item.id) && <span>{knownText(item.id)}</span>}
      </div>
      {item.owner && (
        <div
          className="text-2xs"
          style={{ color: item.owner.stale ? PHASE_COLORS.BLOCKED : undefined }}
        >
          {knownText(item.owner.worker)} · {workStatus(item, board, officeState)}
        </div>
      )}
      {item.agentIds.length > 0 && (
        <div className="flex gap-4 flex-wrap">
          {item.agentIds.map((id) => (
            <Button
              key={id}
              size="sm"
              variant="secondary"
              aria-pressed
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
      {item.prRef && (
        <div className="text-2xs text-text-muted" data-testid="task-pr-status">
          {taskPullRequestLabel(item, now)}
        </div>
      )}
      {open && (
        <div className="text-2xs text-text-muted leading-tight flex flex-col gap-1">
          {item.epic && <div>{knownText(item.epic)}</div>}
          {item.prRef && <div>PR {item.prStatus?.url ?? item.prRef}</div>}
          {item.prStatus?.failedChecks.length ? (
            <div>{item.prStatus.failedChecks.join(', ')}</div>
          ) : null}
          <div>
            Prioridad {item.priority ?? '—'} · tamaño {item.size ?? '—'}
            {item.clickupId ? ` · ClickUp ${item.clickupId}` : ''}
          </div>
          {item.implementer && <div>Implementa: {knownText(item.implementer)}</div>}
          {item.dependsOn && item.dependsOn.length > 0 && (
            <div>Depende de: {item.dependsOn.map(knownText).filter(Boolean).join(', ')}</div>
          )}
          {item.note && <div className="text-text">{readableStateText(item.note)}</div>}
        </div>
      )}
    </div>
  );
}

interface BacklogPanelProps {
  focusedTask?: string | null;
  hosted?: boolean;
  isOpen: boolean;
  onClose: () => void;
  onFocusAgent: (id: number) => void;
  officeState: OfficeState;
}

/** The company's backlog next to the office: phases, owners and last reports. */
export function BacklogPanel({
  isOpen,
  onClose,
  onFocusAgent,
  officeState,
  hosted = false,
  focusedTask,
}: BacklogPanelProps) {
  const board = useBoard();
  const [now, setNow] = useState(() => Date.now());
  const [showDone, setShowDone] = useState(false);
  const needsYouRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [isOpen]);

  useEffect(() => {
    if (
      isOpen &&
      focusedTask &&
      board?.items.some(
        (item) => item.id === focusedTask && ['DONE', 'VERIFIED'].includes(item.phase),
      )
    )
      setShowDone(true);
  }, [isOpen, focusedTask, board]);

  if (!isOpen) return null;

  const items = board?.items ?? [];
  const groups = groupBacklog(items).filter((g) => g.items.length > 0);
  const pulse = backlogPulse(items.map((i) => i.phase));
  const view = backlogView(board);

  return (
    <div
      className="read-only-panel p-8 flex flex-col gap-8"
      data-testid="backlog-panel"
      role="region"
      aria-label="Trabajo"
    >
      <PanelHeading hosted={hosted} title="Trabajo" onClose={onClose} />
      {board && <p className="ui-info">{knownText(board.project)}</p>}

      {view.message && (
        <div className="text-xs text-text-muted">
          {view.message}
          {view.configurationHint && <div>{view.configurationHint}</div>}
          <OfficeRecoveryActions project />
        </div>
      )}
      {view.clickupLink && (
        <a
          className="text-xs text-accent-bright underline"
          href={view.clickupLink.href}
          target={view.clickupLink.target}
          rel={view.clickupLink.rel}
        >
          {view.clickupLink.label}
        </a>
      )}

      {board?.sources.board && (
        <>
          <div className="backlog-pulse flex gap-8 flex-wrap" data-testid="backlog-pulse">
            <span className="backlog-pulse-item">
              <strong>{pulse.working}</strong> Trabajando
            </span>
            <Button
              size="sm"
              variant={pulse.needsYou > 0 ? 'primary' : 'secondary'}
              disabled={pulse.needsYou === 0}
              onClick={() => needsYouRef.current?.scrollIntoView({ block: 'start' })}
              title="Ir a las tareas que esperan tu decisión"
            >
              <strong>{pulse.needsYou}</strong> Te necesitan
            </Button>
            <span className="backlog-pulse-item">
              <strong>{pulse.blocked}</strong> Bloqueadas
            </span>
          </div>
          <div className="ui-info text-text-muted">
            {board.sources.workStore ? (
              'Registro de tareas del proyecto'
            ) : (
              <>
                Coordinación:{' '}
                {board.manager
                  ? board.manager.stale
                    ? 'reserva sin latido'
                    : 'ronda reservada'
                  : 'sin ronda activa'}
                {!board.sources.claims && ' · reservas no disponibles'}
                {!board.sources.progress && ' · sin registro de progreso'}
              </>
            )}
          </div>

          {board.items.length === 0 && (
            <p className="ui-info">
              {board.sources.workStore
                ? 'Aún no hay tareas. Crea una idea y aprueba su plan para empezar.'
                : 'Aún no hay tareas. Aparecerán cuando los agentes empiecen una ronda de trabajo.'}
            </p>
          )}
          {board.summary && (
            <div
              className="flex gap-5 flex-wrap text-2xs text-text-muted"
              data-testid="epic-progress"
            >
              {Object.entries(board.summary.byEpic).map(([epic, count]) => (
                <span key={epic}>
                  {(epic !== '?' && knownText(epic)) || 'Sin funcionalidad asociada'}: {count.done}/
                  {count.total} hechas
                </span>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-8">
            {groups.map((g) => {
              const cards = g.items.map((item) => (
                <Card
                  key={item.id}
                  item={item}
                  focused={item.id === focusedTask}
                  now={now}
                  onFocusAgent={onFocusAgent}
                  board={board}
                  officeState={officeState}
                />
              ));
              const heading = `${g.label} · ${g.items.length}`;
              if (g.id === 'done')
                return (
                  <details
                    key={g.id}
                    className="flex flex-col gap-4"
                    open={showDone}
                    onToggle={(e) => setShowDone(e.currentTarget.open)}
                  >
                    <summary className="text-sm cursor-pointer">{heading}</summary>
                    <div className="flex flex-col gap-4 mt-4">{cards}</div>
                  </details>
                );
              return (
                <section
                  key={g.id}
                  className="flex flex-col gap-4"
                  ref={g.id === 'needsYou' ? needsYouRef : undefined}
                  aria-label={g.label}
                >
                  <h3 className="text-sm">{heading}</h3>
                  {cards}
                </section>
              );
            })}
          </div>

          {board.recent.length > 0 && (
            <div className="border-t-2 border-border pt-6 flex flex-col gap-4">
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
