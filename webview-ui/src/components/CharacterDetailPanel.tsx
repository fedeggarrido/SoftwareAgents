import { useEffect, useState } from 'react';

import type { BoardState, CharacterDetail, ExecutorState } from '../../../core/src/messages.js';
import { pullRequestCi } from '../../../core/src/pullRequest.js';
import {
  CHARACTER_DETAIL_FIELDS,
  CHARACTER_DETAIL_SECOND_MS,
  CHARACTER_DETAIL_UNKNOWN,
  PR_DISPLAY_REFRESH_MS,
} from '../constants.js';

export interface CharacterDetailPanelProps {
  detail?: CharacterDetail;
  executorState?: ExecutorState | null;
  board?: BoardState | null;
}

/** Read-only: every fact is projected by the server, never parsed from labels. */
export function CharacterDetailPanel({ detail, executorState, board }: CharacterDetailPanelProps) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), PR_DISPLAY_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const ci = pullRequestCi(detail?.prStatus, detail?.prObservation, now);
  const provider =
    detail && executorState && executorState.projectId === detail.projectId
      ? executorState.executors.find((row) => row.executorId === detail.executor)
      : undefined;
  const quota =
    detail &&
    board &&
    board.projectId === detail.projectId &&
    (detail.executor === 'claude' || detail.executor === 'codex')
      ? board.quota[detail.executor]
      : undefined;
  return (
    <section
      role="region"
      aria-label="Detalle del personaje"
      data-testid="character-detail-panel"
      className="character-detail-panel read-only-panel absolute top-60 right-8 z-40 pixel-panel p-10 text-xs overflow-y-auto"
    >
      <h2 className="text-lg">Detalle del personaje</h2>
      <dl>
        {CHARACTER_DETAIL_FIELDS.map(([key, label]) => (
          <div key={key}>
            <dt className="text-text-muted">{label}</dt>
            <dd>
              {key === 'ciState' && detail?.prStatus && ci !== detail.prStatus.ci
                ? ci
                : detail?.[key] || CHARACTER_DETAIL_UNKNOWN}
            </dd>
          </div>
        ))}
        <div>
          <dt className="text-text-muted">Disponibilidad</dt>
          <dd>
            {provider &&
            provider.checkedAt !== null &&
            (provider.staleAfter === null ||
              (executorState?.observedAt ?? Infinity) <= provider.staleAfter)
              ? provider.eligible
                ? 'disponible'
                : 'no disponible'
              : CHARACTER_DETAIL_UNKNOWN}
          </dd>
        </div>
        <div>
          <dt className="text-text-muted">Capacidad (activas / límite)</dt>
          <dd>
            {provider?.activeExecutions ?? CHARACTER_DETAIL_UNKNOWN} /{' '}
            {provider?.concurrencyLimit ?? CHARACTER_DETAIL_UNKNOWN}
          </dd>
        </div>
        <div>
          <dt className="text-text-muted">Confianza de capacidad</dt>
          <dd>{quota?.capacity?.confidence ?? CHARACTER_DETAIL_UNKNOWN}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Último evento de cuota</dt>
          <dd>
            {quota
              ? `${quota.status} · ${quota.observedAt == null ? CHARACTER_DETAIL_UNKNOWN : new Date(quota.observedAt * CHARACTER_DETAIL_SECOND_MS).toISOString()}`
              : CHARACTER_DETAIL_UNKNOWN}
          </dd>
        </div>
        <div>
          <dt className="text-text-muted">Cuota utilizada</dt>
          <dd>{quota?.usedPercent == null ? CHARACTER_DETAIL_UNKNOWN : `${quota.usedPercent}%`}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Última comprobación</dt>
          <dd>
            {provider?.checkedAt == null
              ? CHARACTER_DETAIL_UNKNOWN
              : new Date(provider.checkedAt * CHARACTER_DETAIL_SECOND_MS).toISOString()}
          </dd>
        </div>
      </dl>
    </section>
  );
}
