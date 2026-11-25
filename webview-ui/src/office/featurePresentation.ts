import type { FeatureRow } from '../../../core/src/messages.js';
import { es } from '../i18n/es.js';

// Deduced from the design record; completed tasks contradict them. Review, delivery and integration
// are recorded states and always win.
const DERIVED_STATES: ReadonlySet<FeatureRow['state']> = new Set(['in_design', 'in_development']);

/** Task completion does not prove feature closure or integration. Presentation only. */
export function featurePresentation(
  feature: Pick<FeatureRow, 'state' | 'progress' | 'gates' | 'currentTask'>,
): { state: string; nextAction: string } {
  const { progress, state } = feature;
  const complete = progress !== null && progress.total > 0 && progress.done === progress.total;
  return {
    state: complete && DERIVED_STATES.has(state) ? 'feature_tasks_complete' : state,
    nextAction: nextAction(feature, complete),
  };
}

function nextAction(
  { state, progress, gates, currentTask }: Parameters<typeof featurePresentation>[0],
  complete: boolean,
): string {
  if (state === 'merged') return es.features.integrated;
  if (gates.length > 0) return es.features.gates;
  if (state === 'ready_to_merge') return es.features.integrate;
  if (complete) return es.features.verifyClosure;
  if (progress && progress.failed > 0) return es.features.failedTasks(progress.failed);
  if (currentTask) return es.features.followTask;
  return progress && progress.total > 0 ? es.features.queued : es.features.noTasks;
}
