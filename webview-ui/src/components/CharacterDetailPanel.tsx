import type { CSSProperties } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import type { CharacterDetail, ExecutorState } from '../../../core/src/messages.js';
import {
  AGENT_CARD_MAX_HEIGHT_PX,
  AGENT_CARD_WIDTH_PX,
  AGENT_CARD_Z_INDEX,
  AGENT_HISTORY_LIMIT,
  EXTERNAL_SESSION_LABEL,
  EXTERNAL_SESSION_TOOLTIP,
  PANEL_WINDOW_MARGIN_PX,
  PR_DISPLAY_REFRESH_MS,
  WORK_STATE,
} from '../constants.js';
import { useDismissibleLayer } from '../hooks/useDismissibleLayer.js';
import { agentCardPosition } from '../office/agentCardState.js';
import type { AgentHistoryEvent } from '../office/agentHistory.js';
import { agentElapsed } from '../office/agentHistory.js';
import { knownText, relativeTime } from '../office/displayText.js';
import { ContextGauge } from './ContextGauge.js';
import { StatusChip } from './StatusChip.js';
import { Button } from './ui/Button.js';

export interface CharacterDetailPanelProps {
  agentId?: number;
  name?: string;
  role?: string;
  status?: string;
  statusState?: string;
  assignment?: string;
  context?: { used: number; limit: number };
  workspaceName?: string;
  teamName?: string;
  tier?: string;
  detail?: CharacterDetail;
  executorState?: ExecutorState | null;
  task?: { key?: string; title?: string; state?: string };
  executor?: string;
  model?: string;
  history?: readonly AgentHistoryEvent[];
  detailAt?: number;
  anchor?: { x: number; y: number };
  onClose?: () => void;
  onCloseAgent?: () => void;
  onOpenBacklog?: () => void;
}

/** Facts from the runtime and webview observations; absent values stay absent. */
export function CharacterDetailPanel({
  agentId,
  name = 'Agente',
  role,
  status,
  statusState = 'waiting',
  assignment,
  context,
  workspaceName,
  teamName,
  tier,
  detail,
  executorState,
  task,
  executor,
  model,
  history = [],
  detailAt,
  anchor = { x: PANEL_WINDOW_MARGIN_PX, y: PANEL_WINDOW_MARGIN_PX },
  onClose = () => {},
  onCloseAgent,
  onOpenBacklog,
}: CharacterDetailPanelProps) {
  const ref = useRef<HTMLElement>(null);
  const nameId = useId();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), PR_DISPLAY_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  useDismissibleLayer(true, onClose, AGENT_CARD_Z_INDEX, ref);
  const provider =
    detail && executorState && executorState.projectId === detail.projectId
      ? executorState.executors.find((row) => row.executorId === detail.executor)
      : undefined;
  const taskKey = knownText(task?.key) ?? knownText(detail?.taskKey);
  const taskTitle = knownText(task?.title) ?? knownText(detail?.taskTitle);
  const currentModel = knownText(model) ?? knownText(detail?.model);
  const currentExecutor = knownText(detail?.executor) ?? knownText(executor);
  const elapsed = agentElapsed(detail, detailAt, now);
  const { mobile, ...position } = agentCardPosition(
    anchor,
    typeof window === 'undefined'
      ? {
          width: AGENT_CARD_WIDTH_PX + PANEL_WINDOW_MARGIN_PX * 2,
          height: AGENT_CARD_MAX_HEIGHT_PX + PANEL_WINDOW_MARGIN_PX * 2,
        }
      : { width: window.innerWidth, height: window.innerHeight },
  );
  const style: CSSProperties = { ...position, zIndex: AGENT_CARD_Z_INDEX };
  return (
    <section
      ref={ref}
      role="dialog"
      aria-labelledby={nameId}
      tabIndex={-1}
      data-testid="character-detail-panel"
      data-agent-id={agentId}
      style={style}
      className={`agent-card character-detail-panel pixel-panel p-10 text-xs ${mobile ? 'agent-card-mobile' : ''}`}
    >
      <header className="flex items-start justify-between gap-8">
        <div>
          <h2 id={nameId} className="text-lg">
            {knownText(name) ?? 'Agente'}
          </h2>
          {(knownText(role) ?? knownText(detail?.role)) && (
            <p>{knownText(role) ?? knownText(detail?.role)}</p>
          )}
          <StatusChip state={statusState} />
          {status && <p>{status}</p>}
          {assignment && (
            <p
              className={
                assignment === EXTERNAL_SESSION_LABEL ? 'external-session-chip' : undefined
              }
              title={assignment === EXTERNAL_SESSION_LABEL ? EXTERNAL_SESSION_TOOLTIP : undefined}
            >
              {assignment}
            </p>
          )}
          {workspaceName && <p>Carpeta: {knownText(workspaceName)}</p>}
          {teamName && <p>Equipo: {knownText(teamName)}</p>}
          {context && (
            <>
              <p>Contexto usado: {Math.round((context.used / context.limit) * 100)}%</p>
              <ContextGauge {...context} />
            </>
          )}
          {tier && <p>Nivel: {tier}</p>}
        </div>
        <Button size="sm" variant="ghost" aria-label="Cerrar ficha del agente" onClick={onClose}>
          ✕
        </Button>
      </header>
      {(taskKey || taskTitle || currentModel || currentExecutor || elapsed) && (
        <section>
          <h3>Ahora</h3>
          {task?.state && task.state !== WORK_STATE.AVAILABLE && <StatusChip state={task.state} />}
          {(taskKey || taskTitle) && <p>{[taskKey, taskTitle].filter(Boolean).join(' · ')}</p>}
          <dl>
            {currentModel && (
              <div>
                <dt>Modelo</dt>
                <dd>{currentModel}</dd>
              </div>
            )}
            {currentExecutor && (
              <div>
                <dt>Ejecutor</dt>
                <dd>{currentExecutor}</dd>
              </div>
            )}
            {elapsed && (
              <div>
                <dt>Tiempo en la tarea</dt>
                <dd>{elapsed}</dd>
              </div>
            )}
            {provider?.checkedAt != null &&
              (provider.staleAfter === null ||
                executorState!.observedAt <= provider.staleAfter) && (
                <div>
                  <dt>Disponibilidad</dt>
                  <dd>{provider.eligible ? 'disponible' : 'no disponible'}</dd>
                </div>
              )}
          </dl>
        </section>
      )}
      <section>
        <h3>Historial</h3>
        {history.length === 0 ? (
          <p>Aún no hay actividad registrada en esta ventana.</p>
        ) : (
          <ol>
            {[...history]
              .sort((a, b) => b.at - a.at)
              .slice(0, AGENT_HISTORY_LIMIT)
              .map((event) => (
                <li key={event.key}>
                  {knownText(event.text)}{' '}
                  <span className="text-text-muted">· {relativeTime(event.at, now)}</span>
                </li>
              ))}
          </ol>
        )}
      </section>
      <footer className="flex flex-wrap gap-8">
        {onOpenBacklog && (
          <Button size="sm" onClick={onOpenBacklog}>
            Ver en Trabajo
          </Button>
        )}
        {onCloseAgent && (
          <Button size="sm" onClick={onCloseAgent}>
            Cerrar agente
          </Button>
        )}
      </footer>
    </section>
  );
}
