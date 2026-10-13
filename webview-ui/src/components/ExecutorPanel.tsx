import { useEffect, useState } from 'react';

import { executorPanelView } from '../office/executorPanelView.js';
import {
  expirePending,
  getExecutorStore,
  setExecutorStore,
  startToggle,
  useExecutorStore,
} from '../office/executorStore.js';
import { transport } from '../transport/index.js';

/**
 * «Executors para nuevas tareas» (SA-091). The switch is the Operator's choice and
 * changes only when the server confirms it; the text is current eligibility.
 */
export function ExecutorPanel() {
  const store = useExecutorStore();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      const at = Date.now();
      setNow(at);
      const expired = expirePending(getExecutorStore(), at);
      if (!expired.resync) return;
      setExecutorStore(expired.store);
      const projectId = expired.store.state?.projectId;
      if (projectId) transport.send({ type: 'requestExecutorState', projectId });
    }, 1000);
    return () => clearInterval(t);
  }, []);
  const view = executorPanelView(store, now);
  if (!view) return null;

  const toggle = (executorId: string, enabled: boolean) => {
    const message = startToggle(executorId, enabled);
    if (message) transport.send(message);
  };

  return (
    <section
      className="flex flex-col gap-4"
      aria-label={`Executors para nuevas tareas de ${view.projectId}`}
      data-testid="executor-panel"
    >
      <div className="flex flex-wrap justify-between gap-x-8 text-2xs">
        <span className="text-text">Executors para nuevas tareas</span>
        <span className="text-text-muted">Asignación: automática por política</span>
      </div>
      {view.banner && (
        <div className="text-2xs border border-border bg-bg-dark px-5 py-3" role="status">
          {view.banner}
        </div>
      )}
      {view.rows.map((row) => (
        <div
          key={row.executorId}
          className="grid grid-cols-[52px_minmax(0,1fr)] gap-x-8 text-2xs leading-tight"
          data-testid={`executor-row-${row.executorId}`}
        >
          <button
            type="button"
            role="switch"
            aria-checked={row.checked}
            aria-label={row.ariaLabel}
            disabled={row.disabled}
            onClick={() => toggle(row.executorId, !row.checked)}
            className={`self-start border border-border px-4 py-3 leading-none ${
              row.checked ? 'bg-active-bg text-text' : 'bg-bg-dark text-text-muted'
            } ${row.disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-btn-hover'}`}
          >
            {row.checked ? 'ON' : 'OFF'}
          </button>
          <span className="min-w-0">
            <span className="text-text">{row.label}</span>{' '}
            <span style={{ color: row.color }}>● {row.status}</span>
            {row.details.map((line, i) => (
              <span key={i} className="block text-text-muted mt-2">
                {line}
              </span>
            ))}
            {row.error && (
              <span className="block mt-2" role="alert">
                {row.error}
              </span>
            )}
          </span>
        </div>
      ))}
      <div className="text-2xs text-text-muted">
        {view.readOnlyNotice ??
          'Tú eliges qué puede usarse. El programa decide quién hace cada tarea. Desactivar deja terminar las ejecuciones en curso.'}
      </div>
      <div className="sr-only" aria-live="polite">
        {view.live}
      </div>
    </section>
  );
}
