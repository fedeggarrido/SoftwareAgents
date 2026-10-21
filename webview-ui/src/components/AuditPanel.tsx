import { useEffect } from 'react';

import {
  auditNotices,
  auditValue,
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
import { useExecutorStore } from '../office/executorStore.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';

let requestSequence = 0;

export function AuditPanel({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const store = useAuditStore();
  const executor = useExecutorStore();
  const projectId = executor.needsSnapshot ? null : (executor.state?.projectId ?? null);

  useEffect(() => {
    if (!isOpen || !projectId) {
      setAuditStore(emptyAuditStore());
      return;
    }
    if (getAuditStore().projectId === projectId) return;
    const requestId = `audit-${++requestSequence}`;
    setAuditStore(beginAuditRequest(emptyAuditStore(), projectId, requestId));
    transport.send({ type: 'requestAuditLog', projectId, requestId });
  }, [isOpen, projectId, store.projectId]);

  if (!isOpen) return null;
  const state = viewState(store);
  const notices = auditNotices(store);
  const options = filterValues(store.snapshot);
  const clearFilters = () => setAuditStore({ ...getAuditStore(), actionFilter: null, outcomeFilter: null });
  return (
    <section role="region" aria-label="Auditoría" data-testid="audit-panel"
      className="absolute top-60 left-1/2 -translate-x-1/2 z-40 pixel-panel p-10 flex flex-col gap-8 w-[min(960px,92vw)] max-h-[70vh] overflow-y-auto">
      <div className="flex items-center gap-8">
        <h2 className="text-lg flex-1">Auditoría · solo lectura</h2>
        <Button size="sm" variant="ghost" onClick={onClose} title="Cerrar auditoría">✕</Button>
      </div>
      {!store.projectId ? <p>Sin Project seleccionado</p> : <>
        <div className="flex flex-wrap gap-8">
          <label>Acción <select aria-label="Acción" value={store.actionFilter === null ? '' : `value:${store.actionFilter}`}
            onChange={(event) => setAuditStore({ ...getAuditStore(), actionFilter: event.target.value === '' ? null : event.target.value.slice(6) })}>
            <option value="">Todas</option>
            {options.actions.map((value) => <option key={value} value={`value:${value}`}>{value}</option>)}
          </select></label>
          <label>Resultado <select aria-label="Resultado" value={store.outcomeFilter === null ? '' : `value:${store.outcomeFilter}`}
            onChange={(event) => setAuditStore({ ...getAuditStore(), outcomeFilter: event.target.value === '' ? null : event.target.value.slice(6) })}>
            <option value="">Todos</option>
            {options.outcomes.map((value) => <option key={value} value={`value:${value}`}>{value}</option>)}
          </select></label>
          <Button size="sm" onClick={clearFilters}>Quitar filtros</Button>
        </div>
        {notices.truncated && <p>mostrando las 500 más recientes de {notices.totalValid}</p>}
        {notices.corruptLines.length > 0 && <p>{notices.corruptLines.length} líneas corruptas ({notices.corruptLines.slice(0, 50).join(', ')}{notices.corruptLines.length > 50 ? '…' : ''})</p>}
        {notices.excludedCount > 0 && <p>{notices.excludedCount} entradas excluidas por no pertenecer al Project</p>}
        <div role="status">
          {state === 'loading' && 'Cargando auditoría…'}
          {state === 'empty' && 'No hay entradas de auditoría'}
          {state === 'read_error' && 'Error de lectura del audit log'}
          {state === 'denied' && 'Acceso denegado a la auditoría'}
          {state === 'no_matches' && 'Ninguna entrada cumple los filtros. Usa Quitar filtros para ver todas.'}
        </div>
        {visibleEntries(store).map((entry) => {
          const date = formatAuditDate(entry.occurredAt);
          return <article key={`${store.requestId}:${entry.line}`} className="bg-bg-dark border-2 border-border p-8 text-xs break-words">
            <dl>
              <dt>Fecha</dt><dd><span title={date?.utc}>{date?.local ?? 'Fecha no válida'}</span></dd>
              <dt>Actor</dt><dd>{entry.actorType} / {auditValue(entry.actorId)}</dd>
              <dt>Acción</dt><dd>{entry.action}</dd>
              <dt>Recurso</dt><dd>{entry.resourceType} / {auditValue(entry.resourceId)}</dd>
              <dt>Decisión de política</dt><dd>{auditValue(entry.policyDecision?.outcome)} / {auditValue(entry.policyDecision?.reason)}</dd>
              <dt>Resultado</dt><dd>{entry.outcome.status}</dd>
              <dt>Motivo</dt><dd>{auditValue(entry.outcome.reason)}</dd>
              <dt>Task</dt><dd>{auditValue(entry.taskKey)}</dd>
              <dt>Execution</dt><dd>{auditValue(entry.executionId)}</dd>
            </dl>
            <details><summary>Detalle</summary><dl>
              {(['detail', 'tier', 'executor', 'model', 'code'] as const).map((key) => <div key={key}><dt>{key}</dt><dd>{auditValue(entry.outcome[key])}</dd></div>)}
              <dt>riskLevel</dt><dd>{auditValue(entry.riskLevel)}</dd>
            </dl></details>
          </article>;
        })}
      </>}
    </section>
  );
}
