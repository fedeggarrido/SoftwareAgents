import { useEffect, useState } from 'react';

import { useBoard } from '../office/boardStore.js';
import { getFeaturesStore, requestFeatures, useFeaturesStore } from '../office/featuresStore.js';
import { officeEmptyState } from '../office/officeEmptyState.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';

export function OfficeEmptyState({
  agents,
  onNewIdea,
  hidden = false,
}: {
  agents: readonly number[];
  onNewIdea: () => void;
  hidden?: boolean;
}) {
  const board = useBoard();
  const features = useFeaturesStore();
  const [dismissed, setDismissed] = useState(false);
  const state = officeEmptyState(board, features, agents);
  // Once this office has shown work, removing its last session must not restart the welcome.
  if (state === 'used' && !dismissed) setDismissed(true);

  useEffect(() => {
    if (dismissed || state === 'used' || !board?.projectId) return;
    if (getFeaturesStore().projectId !== board.projectId)
      requestFeatures(transport, board.projectId);
    // features.projectId: a store reset (e.g. the first executorState) drops the in-flight read.
  }, [board?.projectId, dismissed, state, features.projectId]);

  if (dismissed || state !== 'empty') return null;
  return (
    <div className="office-empty-space">
      <section
        className="office-empty-state pixel-panel"
        aria-labelledby="office-empty-title"
        hidden={hidden}
      >
        <header>
          <h2 id="office-empty-title">Empieza con una idea</h2>
          <Button
            type="button"
            variant="ghost"
            aria-label="Ocultar bienvenida"
            onClick={() => setDismissed(true)}
          >
            Cerrar
          </Button>
        </header>
        <p>Coordina agentes de IA para construir software y revisa su trabajo aquí.</p>
        <Button type="button" variant="primary" onClick={onNewIdea}>
          Nueva idea
        </Button>
      </section>
    </div>
  );
}
