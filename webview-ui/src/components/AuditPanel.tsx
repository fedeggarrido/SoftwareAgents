import { useEffect, useSyncExternalStore } from 'react';

import {
  AUDIT_DETAIL_FIELDS,
  AUDIT_EMPTY_TEXT,
  AUDIT_EXPLANATION,
  PROJECT_EMPTY_TEXT,
} from '../constants.js';
import { auditSentence } from '../office/auditPresentation.js';
import {
  auditNotices,
  beginAuditRequest,
  emptyAuditStore,
  filterValues,
  formatAuditDate,
  getAuditStore,
  setAuditStore,
  useAuditStore,
  viewState,
  visibleEntries,
} from '../office/auditStore.js';
import { knownText } from '../office/displayText.js';
import { useExecutorStore } from '../office/executorStore.js';
import { transport } from '../transport/index.js';
import { OfficeRecoveryActions } from './OfficeRecoveryActions.js';
import { Button } from './ui/Button.js';
import { PanelError } from './ui/PanelError.js';
import { PanelHeading } from './ui/PanelHeading.js';

let requestSequence = 0;

// Stable callbacks let React subscribe once and re-check connection changes
// between render and subscription, including a fast disconnect/reconnect.
const subscribeTransport = (listener: () => void) => transport.onStateChange(listener);
const transportState = () => transport.state;

function requestAudit(projectId: string) {
  const requestId = `audit-${++requestSequence}`;
  setAuditStore(beginAuditRequest(getAuditStore(), projectId, requestId));
  transport.send({ type: 'requestAuditLog', projectId, requestId });
}

export function AuditPanel({
  isOpen,
  onClose,
  hosted = false,
}: {
  isOpen: boolean;
  onClose: () => void;
  hosted?: boolean;
}) {
  const store = useAuditStore();
  const executor = useExecutorStore();
  const connectionState = useSyncExternalStore(subscribeTransport, transportState, transportState);
  const projectId = executor.needsSnapshot ? null : (executor.state?.projectId ?? null);

  useEffect(() => {
    if (!isOpen || !projectId || connectionState !== 'connected') {
      setAuditStore(emptyAuditStore());
      return;
    }
    if (getAuditStore().projectId === projectId) return;
    requestAudit(projectId);
  }, [isOpen, projectId, store.projectId, connectionState]);

  if (!isOpen) return null;
  const state = viewState(store);
  const notices = auditNotices(store);
  const options = filterValues(store.snapshot);
  const clearFilters = () =>
    setAuditStore({ ...getAuditStore(), actionFilter: null, outcomeFilter: null });
  return (
    <section
      role="region"
      aria-label="Auditoría"
      data-testid="audit-panel"
      className="read-only-panel p-10 flex flex-col gap-8"
    >
      <PanelHeading hosted={hosted} title="Auditoría" onClose={onClose} />
      <p>{AUDIT_EXPLANATION}</p>
      {connectionState !== 'connected' ? null : !projectId ? (
        <>
          <p>{PROJECT_EMPTY_TEXT}</p>
          <OfficeRecoveryActions project />
        </>
      ) : (
        <>
          <div className="audit-filters flex flex-wrap gap-8">
            <label>
              Acción{' '}
              <select
                aria-label="Acción"
                value={store.actionFilter === null ? '' : `value:${store.actionFilter}`}
                onChange={(event) =>
                  setAuditStore({
                    ...getAuditStore(),
                    actionFilter: event.target.value === '' ? null : event.target.value.slice(6),
                  })
                }
              >
                <option value="">Todas</option>
                {options.actions.map((value) => (
                  <option key={value} value={`value:${value}`}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Resultado{' '}
              <select
                aria-label="Resultado"
                value={store.outcomeFilter === null ? '' : `value:${store.outcomeFilter}`}
                onChange={(event) =>
                  setAuditStore({
                    ...getAuditStore(),
                    outcomeFilter: event.target.value === '' ? null : event.target.value.slice(6),
                  })
                }
              >
                <option value="">Todos</option>
                {options.outcomes.map((value) => (
                  <option key={value} value={`value:${value}`}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <Button
              size="sm"
              onClick={clearFilters}
              disabled={store.actionFilter === null && store.outcomeFilter === null}
            >
              Quitar filtros
            </Button>
          </div>
          {notices.truncated && <p>mostrando las 500 más recientes de {notices.totalValid}</p>}
          {notices.corruptLines.length > 0 && (
            <p>
              {notices.corruptLines.length} líneas corruptas (
              {notices.corruptLines.slice(0, 50).join(', ')}
              {notices.corruptLines.length > 50 ? '…' : ''})
            </p>
          )}
          {notices.excludedCount > 0 && (
            <p>{notices.excludedCount} entradas excluidas por no pertenecer al proyecto</p>
          )}
          <div role="status">
            {state === 'loading' && 'Cargando auditoría…'}
            {state === 'empty' && AUDIT_EMPTY_TEXT}
            {state === 'denied' && 'Acceso denegado a la auditoría'}
            {state === 'no_matches' &&
              'Ninguna entrada cumple los filtros. Usa Quitar filtros para ver todas.'}
          </div>
          {state === 'read_error' && (
            <PanelError
              cause="No se pudo consultar el registro de auditoría."
              disabled={!projectId || connectionState !== 'connected'}
              onRetry={() => {
                if (projectId && connectionState === 'connected') requestAudit(projectId);
              }}
            />
          )}
          {visibleEntries(store).map((entry) => {
            const date = formatAuditDate(entry.occurredAt);
            return (
              <article
                key={`${store.requestId}:${entry.line}`}
                className="bg-bg-dark border-2 border-border p-8 text-xs break-words"
              >
                <p title={date?.utc}>{auditSentence(entry)}</p>
                <details>
                  <summary>Detalle</summary>
                  <dl>
                    {knownText(entry.outcome.reason) && (
                      <div>
                        <dt>Motivo</dt>
                        <dd>{knownText(entry.outcome.reason)}</dd>
                      </div>
                    )}
                    {knownText(entry.policyDecision?.reason) && (
                      <div>
                        <dt>Regla de seguridad</dt>
                        <dd>{knownText(entry.policyDecision?.reason)}</dd>
                      </div>
                    )}
                    {AUDIT_DETAIL_FIELDS.map(([key, label]) => (
                      <div key={key}>
                        <dt>{label}</dt>
                        <dd>{knownText(entry.outcome[key]) ?? 'sin valor'}</dd>
                      </div>
                    ))}
                    <dt>Nivel de riesgo</dt>
                    <dd>{knownText(entry.riskLevel) ?? 'sin valor'}</dd>
                  </dl>
                </details>
              </article>
            );
          })}
        </>
      )}
    </section>
  );
}
