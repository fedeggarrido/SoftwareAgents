import { useEffect, useSyncExternalStore } from 'react';

import { useExecutorStore } from '../office/executorStore.js';
import {
  beginFeaturesRequest,
  emptyFeaturesStore,
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
  return (
    <section
      role="region"
      aria-label="Features"
      data-testid="features-panel"
      className="absolute top-60 left-1/2 -translate-x-1/2 z-40 pixel-panel p-10 flex flex-col gap-8 w-[min(960px,92vw)] max-h-[70vh] overflow-y-auto"
    >
      <div className="flex items-center gap-8">
        <h2 className="text-lg flex-1">Features · solo lectura</h2>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cerrar
        </Button>
        <Button
          size="sm"
          disabled={!projectId || connectionState !== 'connected'}
          onClick={() => {
            if (projectId && connectionState === 'connected') requestFeatures(projectId);
          }}
        >
          Actualizar
        </Button>
      </div>
      {!projectId ? (
        <p>Sin Project seleccionado</p>
      ) : (
        <>
          <div role="status">
            {state === 'loading' && 'Cargando features…'}
            {state === 'empty' && 'sin features'}
            {state === 'denied' && 'Acceso denegado a las features'}
            {state === 'read_error' &&
              `Error de lectura: ${featuresReasonText(selectedStore.snapshot?.reason ?? null)}`}
          </div>
          {visibleFeatures(selectedStore).map((feature) => (
            <article
              key={feature.key}
              className="bg-bg-dark border-2 border-border p-8 text-xs break-words"
            >
              <h3>
                {feature.key}
                {feature.title ? ` · ${feature.title}` : ''}
              </h3>
              <dl>
                <dt>Estado</dt>
                <dd>{featureStateLabel(feature)}</dd>
                <dt>Progreso</dt>
                <dd>{featureProgressLabel(feature.progress)}</dd>
                {feature.currentTask && (
                  <>
                    <dt>Tarea en curso</dt>
                    <dd>
                      {feature.currentTask.key} {feature.currentTask.step}
                      {feature.currentTask.others > 0 && ` (+${feature.currentTask.others})`}
                    </dd>
                  </>
                )}
                {feature.integration && (
                  <>
                    <dt>Rama de integración</dt>
                    <dd>
                      {feature.integration.branch} {feature.integration.sha}
                    </dd>
                  </>
                )}
              </dl>
              {feature.gates.map((gate, index) => (
                <div key={index}>
                  <p>
                    {gate.kind} {gate.task}
                    {gate.expired && ' · expirado'}
                  </p>
                  <code>{gate.command}</code>
                </div>
              ))}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
