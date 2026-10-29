import { useEffect, useSyncExternalStore } from 'react';

import { FEATURE_PROGRESS_PERCENT_MAX } from '../constants.js';
import { useExecutorStore } from '../office/executorStore.js';
import {
  beginFeaturesRequest,
  emptyFeaturesStore,
  featureCacheRateLabel,
  featureCostLabel,
  featureCostPerDoneLabel,
  featureCoverageLabel,
  featureProgressLabel,
  featuresReasonText,
  featureStateLabel,
  getFeaturesStore,
  setFeaturesStore,
  useFeaturesStore,
  viewState,
  visibleFeatures,
} from '../office/featuresStore.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';
import { PanelError } from './ui/PanelError.js';
import { PanelHeading } from './ui/PanelHeading.js';

let requestSequence = 0;
const subscribeTransport = (listener: () => void) => transport.onStateChange(listener);
const transportState = () => transport.state;

function requestFeatures(projectId: string) {
  const requestId = `features-${++requestSequence}`;
  setFeaturesStore(beginFeaturesRequest(getFeaturesStore(), projectId, requestId));
  transport.send({ type: 'requestFeatures', projectId, requestId });
}

export function FeaturesPanel({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const store = useFeaturesStore();
  const executor = useExecutorStore();
  const connectionState = useSyncExternalStore(subscribeTransport, transportState, transportState);
  const projectId = executor.needsSnapshot ? null : (executor.state?.projectId ?? null);

  useEffect(() => {
    if (!isOpen || !projectId || connectionState !== 'connected') {
      setFeaturesStore(emptyFeaturesStore());
      return;
    }
    if (getFeaturesStore().projectId !== projectId) requestFeatures(projectId);
  }, [isOpen, projectId, store.projectId, connectionState]);

  if (!isOpen) return null;
  // A Project switch must hide the old rows even before the effect clears them.
  const selectedStore =
    store.projectId === projectId && connectionState === 'connected' ? store : emptyFeaturesStore();
  const state = viewState(selectedStore);
  const refresh = () => {
    if (projectId && connectionState === 'connected') requestFeatures(projectId);
  };
  return (
    <section
      role="region"
      aria-label="Features"
      data-testid="features-panel"
      className="read-only-panel absolute top-60 z-40 pixel-panel p-10 flex flex-col gap-8 max-h-[70vh] overflow-y-auto"
    >
      <PanelHeading title="Features" onClose={onClose}>
        {state !== 'read_error' && (
          <Button
            size="sm"
            disabled={!projectId || connectionState !== 'connected'}
            onClick={refresh}
          >
            Actualizar
          </Button>
        )}
      </PanelHeading>
      {!projectId ? (
        <p>Sin Project seleccionado</p>
      ) : (
        <>
          <div role="status">
            {state === 'loading' && 'Cargando features…'}
            {state === 'empty' && (
              <p>
                Sin features todavía. Se crean con{' '}
                <code className="feature-command">
                  {'pixel-agents feature run <FEAT> --request <file>'}
                </code>
              </p>
            )}
            {state === 'denied' && 'Acceso denegado a las features'}
          </div>
          {state === 'read_error' && (
            <PanelError
              cause={`Error de lectura: ${featuresReasonText(selectedStore.snapshot?.reason ?? null)}`}
              onRetry={refresh}
              disabled={connectionState !== 'connected'}
            />
          )}
          {visibleFeatures(selectedStore).map((feature) => (
            <article
              key={feature.key}
              className="feature-row bg-bg-dark border-2 border-border p-8 text-xs"
              data-state={feature.state}
            >
              <h3 className="feature-heading" title={feature.title ?? feature.key}>
                <span className="text-accent-bright">{feature.key}</span>
                {feature.title && <span className="feature-title"> · {feature.title}</span>}
              </h3>
              <span className="feature-state-chip">{featureStateLabel(feature)}</span>
              <div className="feature-progress">
                {feature.progress && (
                  <div
                    className="feature-progress-track"
                    role="progressbar"
                    aria-label={`Progreso de ${feature.key}`}
                    aria-valuemin={0}
                    aria-valuemax={feature.progress.total}
                    aria-valuenow={feature.progress.done}
                    aria-valuetext={featureProgressLabel(feature.progress)}
                  >
                    <span
                      style={{
                        width: `${Math.min(FEATURE_PROGRESS_PERCENT_MAX, (feature.progress.done / feature.progress.total) * FEATURE_PROGRESS_PERCENT_MAX)}%`,
                      }}
                    />
                  </div>
                )}
                <span>{featureProgressLabel(feature.progress)}</span>
              </div>
              <div className="feature-cost flex flex-wrap gap-8 text-text-muted">
                <span>Coste: {featureCostLabel(feature.cost)}</span>
                <span>Ejecuciones: {feature.cost.executions}</span>
                <span>Cobertura: {featureCoverageLabel(feature.cost)}</span>
                <span>Coste/tarea DONE: {featureCostPerDoneLabel(feature.cost)}</span>
                <span>Caché: {featureCacheRateLabel(feature.cost)}</span>
              </div>
              <div className="feature-context text-text-muted">
                {feature.currentTask && (
                  <span title="Tarea en curso">
                    {feature.currentTask.key} {feature.currentTask.step}
                    {feature.currentTask.others > 0 && ` (+${feature.currentTask.others})`}
                  </span>
                )}
                {feature.gates.map((gate, index) => (
                  <div key={index} className="feature-gate">
                    <span>
                      {gate.kind} {gate.task}
                      {gate.expired && ' · expirado'}
                    </span>
                    <code>{gate.command}</code>
                  </div>
                ))}
              </div>
              {feature.integration && (
                <span
                  className="feature-integration text-text-muted"
                  title={feature.integration.branch}
                >
                  {feature.integration.branch.replace(/^sa\//, '')} {feature.integration.sha}
                </span>
              )}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
