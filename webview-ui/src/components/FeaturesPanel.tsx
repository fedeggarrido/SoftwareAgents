import { useEffect } from 'react';

import {
  OFFICE_ACCESS_INSTRUCTIONS,
  OFFICE_MANAGED_EXPLANATION,
} from '../../../core/src/officeAccess.js';
import { PROJECT_EMPTY_TEXT } from '../constants.js';
import { FEATURE_PROGRESS_PERCENT_MAX } from '../constants.js';
import { es } from '../i18n/es.js';
import { useExecutorStore } from '../office/executorStore.js';
import { featurePresentation } from '../office/featurePresentation.js';
import { featureStepLabel } from '../office/featuresStore.js';
import {
  emptyFeaturesStore,
  featureCacheRateLabel,
  featureCostLabel,
  featureCostPerDoneLabel,
  featureCoverageLabel,
  featureProgressLabel,
  featuresReasonText,
  getFeaturesStore,
  requestFeatures,
  setFeaturesStore,
  useFeaturesStore,
  viewState,
  visibleFeatures,
} from '../office/featuresStore.js';
import { ideaErrorText, requestIdeas } from '../office/ideasStore.js';
import { useIdeasConnection } from '../office/useIdeasConnection.js';
import { useProjectSummary } from '../office/useProjectSummary.js';
import { transport } from '../transport/index.js';
import { FeaturePlanButton } from './FeaturePlanDialog.js';
import { IdeasList } from './IdeasList.js';
import { OfficeRecoveryActions } from './OfficeRecoveryActions.js';
import { StatusChip } from './StatusChip.js';
import { Button } from './ui/Button.js';
import { PanelError } from './ui/PanelError.js';
import { PanelHeading } from './ui/PanelHeading.js';

export function FeaturesPanel({
  isOpen,
  onClose,
  checkoutName,
  hosted = false,
}: {
  hosted?: boolean;
  isOpen: boolean;
  onClose: () => void;
  checkoutName?: string;
}) {
  const store = useFeaturesStore();
  const executor = useExecutorStore();
  const executorProjectId = executor.state?.projectId ?? null;
  const { store: ideas, connection: connectionState } = useIdeasConnection(
    isOpen,
    executorProjectId,
  );
  const projectId = executorProjectId ?? ideas.snapshot?.projectId ?? null;
  const summary = useProjectSummary(isOpen);
  const ideaGoals =
    summary.snapshot?.status === 'ok' && summary.snapshot.projectId === projectId
      ? summary.snapshot.summary?.goals
      : undefined;

  useEffect(() => {
    if (!isOpen) return;
    if (!projectId || connectionState !== 'connected') {
      setFeaturesStore(emptyFeaturesStore());
      return;
    }
    const current = getFeaturesStore();
    // Opening refreshes cached rows, but can share the welcome's in-flight read.
    if (current.projectId !== projectId || !current.loading) requestFeatures(transport, projectId);
  }, [isOpen, projectId, connectionState]);

  if (!isOpen) return null;
  // A Project switch must hide the old rows even before the effect clears them.
  const selectedStore =
    store.projectId === projectId && connectionState === 'connected' ? store : emptyFeaturesStore();
  const state = viewState(selectedStore);
  const refresh = () => {
    if (connectionState === 'connected') {
      requestIdeas(transport);
      summary.refresh();
    }
    if (projectId && connectionState === 'connected') requestFeatures(transport, projectId);
  };
  return (
    <section
      role="region"
      aria-label="Funcionalidades"
      data-testid="features-panel"
      className="read-only-panel p-10 flex flex-col gap-8"
    >
      <PanelHeading hosted={hosted} title="Funcionalidades" onClose={onClose}>
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
        {connectionState !== 'connected' ? null : !ideas.snapshot ? (
          <p role="status">Cargando ideas pendientes…</p>
        ) : ideas.snapshot.errorCode === 'denied' ||
          ideas.snapshot.preparationError === 'denied' ? (
          <div role="status">
            <p>
              {ideas.snapshot.preparationError === 'denied'
                ? OFFICE_MANAGED_EXPLANATION
                : OFFICE_ACCESS_INSTRUCTIONS}
            </p>
            <OfficeRecoveryActions />
          </div>
        ) : ideas.snapshot.errorCode ? (
          <PanelError
            cause={`No se pudieron leer las ideas. ${ideaErrorText(ideas.snapshot.errorCode)}`}
            onRetry={() => requestIdeas(transport)}
          />
        ) : !projectId || ideas.snapshot.projectId === projectId ? (
          <IdeasList
            ideas={ideas.snapshot.ideas}
            checkoutName={checkoutName}
            goals={ideaGoals}
            loading={summary.store.phase === 'loading' || summary.store.phase === 'idle'}
          />
        ) : (
          <p role="status">Cargando ideas pendientes…</p>
        )}
      </div>
      {!projectId ? (
        <div>
          {connectionState === 'connected' &&
          !executor.needsSnapshot &&
          (ideas.snapshot?.errorCode === 'no_project' ||
            ideas.snapshot?.errorCode === 'missing_manifest') ? (
            <>
              <p>{PROJECT_EMPTY_TEXT}</p>
              <OfficeRecoveryActions project />
            </>
          ) : connectionState === 'connected' ? (
            <p role="status">{es.features.projectLoading}</p>
          ) : null}
        </div>
      ) : (
        <>
          <div role="status">
            {state === 'loading' && 'Cargando funcionalidades…'}
            {state === 'empty' && (
              <p>
                Sin funcionalidades todavía. Se crean con{' '}
                <code className="feature-command">
                  {'pixel-agents feature run <FEAT> --request <file>'}
                </code>
              </p>
            )}
            {state === 'denied' && 'Acceso denegado a las funcionalidades'}
          </div>
          {state === 'read_error' && (
            <PanelError
              cause={`Error de lectura: ${featuresReasonText(selectedStore.snapshot?.reason ?? null)}`}
              onRetry={refresh}
              disabled={connectionState !== 'connected'}
            />
          )}
          {visibleFeatures(selectedStore).map((feature) => {
            const presentation = featurePresentation(feature);
            return (
              <article
                key={feature.key}
                className="feature-row bg-bg-dark border-2 border-border p-8"
                data-state={presentation.state}
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
                <StatusChip state={presentation.state} />
                {feature.progress && (
                  <p>
                    {es.features.progress}:{' '}
                    {es.features.tasksDone(feature.progress.done, feature.progress.total)}
                  </p>
                )}
                <p>
                  {es.features.next}: {presentation.nextAction}
                </p>
                <p title={es.features.costHint}>
                  {es.features.cost}: {featureCostLabel(feature.cost)}. {es.features.costHint}
                </p>
                <details className="feature-details">
                  <summary>{es.features.details}</summary>
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
                    title={es.features.costHint}
                  >
                    <span>Ejecuciones: {feature.cost.executions}</span>
                    <span>Cobertura: {featureCoverageLabel(feature.cost)}</span>
                    <span>Coste est./tarea hecha: {featureCostPerDoneLabel(feature.cost)}</span>
                    <span>Caché: {featureCacheRateLabel(feature.cost)}</span>
                  </div>
                </details>
                <div className="feature-context text-text-muted">
                  {feature.currentTask && (
                    <span title="Tarea en curso">
                      {feature.currentTask.key} {featureStepLabel(feature.currentTask.step)}
                      {feature.currentTask.others > 0 && ` (+${feature.currentTask.others})`}
                    </span>
                  )}
                  {feature.gates.map((gate, index) => (
                    <div key={index} className="feature-gate">
                      <span>
                        {featureStepLabel(gate.kind)} {gate.task}
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
            );
          })}
        </>
      )}
    </section>
  );
}
