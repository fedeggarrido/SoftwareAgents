import { useEffect, useRef, useState } from 'react';

import type { WorkflowStageId } from '../../../core/src/messages.js';
import { PHASE_COLORS, PRIORITY_COLORS } from '../constants.js';
import { backlogPulse, groupBacklog } from '../office/backlogGroups.js';
import { backlogView } from '../office/backlogView.js';
import type { BoardEvent, BoardItem } from '../office/boardStore.js';
import { useBoard } from '../office/boardStore.js';
import { characterActivity } from '../office/characterActivity.js';
import { knownText } from '../office/displayText.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { readableStateText } from '../office/statusPresentation.js';
import { taskPrDescription, taskTitle } from '../office/taskDetailPresentation.js';
import { useProjectSummary } from '../office/useProjectSummary.js';
import { workflowBacklog } from '../office/workflowBacklog.js';
import { OfficeRecoveryActions } from './OfficeRecoveryActions.js';
import { StatusChip } from './StatusChip.js';
import { TaskDetail } from './TaskDetail.js';
import { Button } from './ui/Button.js';
import { PanelHeading } from './ui/PanelHeading.js';

function workStatus(
  item: BoardItem,
  board: ReturnType<typeof useBoard>,
  office: OfficeState,
): string | undefined {
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
  // Otherwise the card's StatusChip already says it; repeating it adds noise.
  return undefined;
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}min`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function EventLine({ e, now, chip = true }: { e: BoardEvent; now: number; chip?: boolean }) {
  return (
    <div className="text-2xs leading-tight text-text-muted">
      {chip ? <StatusChip state={e.phase} /> : 'Último cambio'} · hace {ago(e.at, now)}
      <div
        className="overflow-hidden text-ellipsis whitespace-nowrap"
        title={readableStateText(e.detail)}
      >
        {readableStateText(e.detail)}
      </div>
    </div>
  );
}

function Card({
  item,
  now,
  onFocusAgent,
  board,
  officeState,
  focused,
  onOpen,
}: {
  item: BoardItem;
  now: number;
  onFocusAgent: (id: number) => void;
  board: ReturnType<typeof useBoard>;
  officeState: OfficeState;
  focused: boolean;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView({ block: 'nearest' });
    ref.current?.focus({ preventScroll: true });
  }, [focused]);
  return (
    <div
      className="bg-bg-dark border-2 border-border p-6 flex flex-col gap-2 cursor-pointer"
      style={{ borderLeftColor: PRIORITY_COLORS[item.priority ?? ''] ?? undefined }}
      onClick={onOpen}
      ref={ref}
      tabIndex={-1}
      data-task-key={item.id}
      data-testid="backlog-card"
    >
      <Button
        className="backlog-card-title"
        variant="ghost"
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
      >
        {taskTitle(item)}
      </Button>
      <div className="flex items-center gap-6 flex-wrap text-2xs text-text-muted">
        <StatusChip state={item.phase} />
        {taskTitle(item) !== knownText(item.id) && <span>{knownText(item.id)}</span>}
      </div>
      {item.owner && (
        <div
          className="text-2xs"
          style={{ color: item.owner.stale ? PHASE_COLORS.BLOCKED : undefined }}
        >
          {[knownText(item.owner.worker), workStatus(item, board, officeState)]
            .filter(Boolean)
            .join(' · ')}
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
      {item.lastEvent && <EventLine e={item.lastEvent} now={now} chip={false} />}
      {item.prRef && (
        <div className="text-2xs text-text-muted" data-testid="task-pr-status">
          {taskPrDescription(item)}
        </div>
      )}
    </div>
  );
}

interface BacklogPanelProps {
  workflowStage: WorkflowStageId | null;
  onClearWorkflowStage: () => void;
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
  workflowStage = null,
  onClearWorkflowStage,
}: BacklogPanelProps) {
  const board = useBoard();
  const summary = useProjectSummary(isOpen && workflowStage !== null);
  const [now, setNow] = useState(() => Date.now());
  const [showDone, setShowDone] = useState(false);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [returnFocus, setReturnFocus] = useState<string | null>(null);
  const needsYouRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (isOpen && focusedTask) setSelectedTask(focusedTask);
  }, [isOpen, focusedTask]);
  useEffect(() => {
    if (isOpen && workflowStage) setSelectedTask(null);
  }, [isOpen, workflowStage]);
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

  const filtered = workflowBacklog(
    board?.projectId === summary.projectId || !workflowStage ? (board?.items ?? []) : [],
    summary.snapshot,
    summary.projectId,
    workflowStage,
  );
  const items = filtered.items;
  const groups = groupBacklog(items).filter((g) => g.items.length > 0);
  const pulse = backlogPulse(items.map((i) => i.phase));
  const view = backlogView(board);

  const selected = board?.items.find((item) => item.id === selectedTask);
  if (selected && board)
    return (
      <div
        className="read-only-panel p-8 flex flex-col gap-8"
        data-testid="backlog-panel"
        role="region"
        aria-label="Trabajo"
      >
        <PanelHeading hosted={hosted} title="Trabajo" onClose={onClose} />
        <TaskDetail
          key={`${board.projectId}-${selected.id}`}
          item={selected}
          board={board}
          onSelectTask={setSelectedTask}
          onBack={() => {
            setReturnFocus(selected.id);
            setSelectedTask(null);
          }}
        />
      </div>
    );

  return (
    <div
      className="read-only-panel p-8 flex flex-col gap-8"
      data-testid="backlog-panel"
      role="region"
      aria-label="Trabajo"
    >
      <PanelHeading hosted={hosted} title="Trabajo" onClose={onClose} />
      {workflowStage && (
        <div className="workflow-backlog-filter" role="status">
          <span>{filtered.stage ? `Etapa · ${filtered.stage.label}` : filtered.message}</span>
          <Button onClick={onClearWorkflowStage}>Ver todo el trabajo</Button>
          {summary.snapshot?.status === 'read_error' && (
            <Button onClick={summary.refresh}>Reintentar</Button>
          )}
          {filtered.stage && items.length === 0 && (
            <p>
              Sin tareas en esta etapa. {filtered.stage.featureKeys.length}{' '}
              {filtered.stage.featureKeys.length === 1 ? 'funcionalidad' : 'funcionalidades'}.
            </p>
          )}
        </div>
      )}
      <p>
        Consulta las tareas y sus decisiones pendientes. Abre una tarea para ver el detalle o pedir
        un cambio.
      </p>
      {board && (
        <div className="backlog-project">
          <span>{knownText(board.project)}</span>
          {view.clickupLink && (
            <a
              className="text-accent-bright underline"
              href={view.clickupLink.href}
              target={view.clickupLink.target}
              rel={view.clickupLink.rel}
            >
              {view.clickupLink.label}
            </a>
          )}
        </div>
      )}

      {view.message && (
        <div className="text-xs text-text-muted">
          {view.message}
          {view.configurationHint && <div>{view.configurationHint}</div>}
          <OfficeRecoveryActions project />
        </div>
      )}

      {board?.sources.board && (
        <>
          <div className="backlog-pulse" data-testid="backlog-pulse">
            <div className="backlog-stat">
              <span className="backlog-stat-value">{pulse.working}</span>
              <span className="backlog-stat-label">Trabajando</span>
            </div>
            {pulse.needsYou > 0 ? (
              <button
                type="button"
                className="backlog-stat backlog-stat-attention"
                onClick={() => needsYouRef.current?.scrollIntoView({ block: 'start' })}
                title="Ir a las tareas que esperan tu decisión"
              >
                <span className="backlog-stat-value">{pulse.needsYou}</span>
                <span className="backlog-stat-label">Te necesitan</span>
              </button>
            ) : (
              <div className="backlog-stat">
                <span className="backlog-stat-value">0</span>
                <span className="backlog-stat-label">Te necesitan</span>
              </div>
            )}
            <div className="backlog-stat">
              <span className="backlog-stat-value">{pulse.blocked}</span>
              <span className="backlog-stat-label">Bloqueadas</span>
            </div>
          </div>
          {!board.sources.workStore && (
            <div className="ui-info text-text-muted">
              Coordinación:{' '}
              {board.manager
                ? board.manager.stale
                  ? 'reserva sin latido'
                  : 'ronda reservada'
                : 'sin ronda activa'}
              {!board.sources.claims && ' · reservas no disponibles'}
              {!board.sources.progress && ' · sin registro de progreso'}
            </div>
          )}

          {board.items.length === 0 && !workflowStage && (
            <p className="ui-info">
              {board.sources.workStore
                ? 'Aún no hay tareas. Crea una idea y aprueba su plan para empezar.'
                : 'Aún no hay tareas. Aparecerán cuando los agentes empiecen una ronda de trabajo.'}
            </p>
          )}
          {board.summary && !workflowStage && (
            <div className="backlog-epics" data-testid="epic-progress">
              {Object.entries(board.summary.byEpic).map(([epic, count]) => (
                <span key={epic} className="backlog-epic">
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
                  focused={item.id === returnFocus}
                  onOpen={() => setSelectedTask(item.id)}
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
                    open={showDone || workflowStage !== null}
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

          {board.recent.length > 0 && !workflowStage && (
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
