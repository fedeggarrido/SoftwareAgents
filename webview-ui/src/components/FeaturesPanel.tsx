import { useEffect } from 'react';

import {
  OFFICE_ACCESS_INSTRUCTIONS,
  OFFICE_MANAGED_EXPLANATION,
} from '../../../core/src/officeAccess.js';
import { FEATURE_COST_ESTIMATE_HINT, FEATURE_PROGRESS_PERCENT_MAX } from '../constants.js';
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
import { ideaErrorText, requestIdeas } from '../office/ideasStore.js';
import { useIdeasConnection } from '../office/useIdeasConnection.js';
import { transport } from '../transport/index.js';
import { FeaturePlanButton } from './FeaturePlanDialog.js';
import { IdeasList } from './IdeasList.js';
import { Button } from './ui/Button.js';
import { PanelError } from './ui/PanelError.js';
import { PanelHeading } from './ui/PanelHeading.js';

let requestSequence = 0;
function requestFeatures(projectId: string) {
  const requestId = `features-${++requestSequence}`;
  setFeaturesStore(beginFeaturesRequest(getFeaturesStore(), projectId, requestId));
  transport.send({ type: 'requestFeatures', projectId, requestId });
}

export function FeaturesPanel({
  isOpen,
  onClose,
  checkoutName,
}: {
  isOpen: boolean;
  onClose: () => void;
  checkoutName?: string;
}) {
  const store = useFeaturesStore();
  const executor = useExecutorStore();
  const projectId = executor.needsSnapshot ? null : (executor.state?.projectId ?? null);
  const { store: ideas, connection: connectionState } = useIdeasConnection(isOpen, projectId);

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
    if (connectionState === 'connected') requestIdeas(transport);
    if (projectId && connectionState === 'connected') requestFeatures(projectId);
  };
  return (
    <section
      role="region"
      aria-label="Features"
      data-testid="features-panel"
      className="read-only-panel p-10 flex flex-col gap-8"
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
      <div aria-label="Ideas pendientes">
        {connectionState !== 'connected' ? (
          <p role="status">Sin conexión para leer ideas pendientes.</p>
        ) : !ideas.snapshot ? (
          <p role="status">Cargando ideas pendientes…</p>
        ) : ideas.snapshot.errorCode === 'denied' ||
          ideas.snapshot.preparationError === 'denied' ? (
          <p role="status">
            {ideas.snapshot.preparationError === 'denied'
              ? OFFICE_MANAGED_EXPLANATION
              : OFFICE_ACCESS_INSTRUCTIONS}
          </p>
        ) : ideas.snapshot.errorCode ? (
          <PanelError
            cause={`No se pudieron leer las ideas. ${ideaErrorText(ideas.snapshot.errorCode)}`}
            onRetry={() => requestIdeas(transport)}
          />
        ) : !projectId || ideas.snapshot.projectId === projectId ? (
          <IdeasList ideas={ideas.snapshot.ideas} checkoutName={checkoutName} />
        ) : (
          <p role="status">Cargando ideas pendientes…</p>
        )}
      </div>
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
              <FeaturePlanButton
                key={`${projectId}/${feature.key}`}
                projectId={projectId}
                featureKey={feature.key}
              />
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
              {feature.flow && <div className="text-text-muted">{feature.flow}</div>}
              <div
                className="feature-cost flex flex-wrap gap-8 text-text-muted"
                title={FEATURE_COST_ESTIMATE_HINT}
              >
                <span>Coste est. API: {featureCostLabel(feature.cost)}</span>
                <span>Ejecuciones: {feature.cost.executions}</span>
                <span>Cobertura: {featureCoverageLabel(feature.cost)}</span>
                <span>Coste est./tarea DONE: {featureCostPerDoneLabel(feature.cost)}</span>
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
                    {gate.reason && <span>{gate.reason}</span>}
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
