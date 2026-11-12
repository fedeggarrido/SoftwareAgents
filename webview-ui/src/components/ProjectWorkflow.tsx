import type { WorkflowStage, WorkflowStageId } from '../../../core/src/messages.js';
import { StatusChip } from './StatusChip.js';

export function ProjectWorkflow({
  stages,
  onSelect,
}: {
  stages: WorkflowStage[];
  onSelect: (id: WorkflowStageId) => void;
}) {
  return (
    <section className="project-workflow" aria-label="Flujo de trabajo del proyecto">
      <details>
        <summary>Flujo de trabajo</summary>
        <ol>
          {stages.map((stage) => (
            <li key={stage.id}>
              <button
                type="button"
                className="workflow-node"
                data-state={stage.state}
                onClick={() => onSelect(stage.id)}
                aria-label={`Ver ${stage.label} en Trabajo`}
                aria-describedby={`workflow-stage-${stage.id}`}
              >
                <span className="workflow-stage-title">{stage.label}</span>
                <span id={`workflow-stage-${stage.id}`} className="workflow-stage-summary">
                  <StatusChip state={stage.state} />
                  <span>
                    {stage.taskKeys.length} {stage.taskKeys.length === 1 ? 'tarea' : 'tareas'} ·{' '}
                    {stage.featureKeys.length}{' '}
                    {stage.featureKeys.length === 1 ? 'funcionalidad' : 'funcionalidades'}
                  </span>
                  <span>
                    {stage.agents.length
                      ? stage.agents.map((session) => `Sesión ${session}`).join(' · ')
                      : 'Sin sesiones activas'}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
