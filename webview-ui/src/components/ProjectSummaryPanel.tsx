import type {
  ProjectSummary,
  ProjectSummaryItem,
  WorkflowStageId,
} from '../../../core/src/messages.js';
import { PROJECT_EMPTY_TEXT } from '../constants.js';
import { featureCostLabel, featuresReasonText } from '../office/featuresStore.js';
import type { PanelTab } from '../office/panelWindowState.js';
import { useProjectSummary } from '../office/useProjectSummary.js';
import { GithubHostingWizard } from './GithubHostingWizard.js';
import { ProjectWorkflow } from './ProjectWorkflow.js';
import { StatusChip } from './StatusChip.js';
import { Button } from './ui/Button.js';
import { PanelHeading } from './ui/PanelHeading.js';

function SummaryList({
  title,
  items,
  empty,
}: {
  title: string;
  items: ProjectSummaryItem[];
  empty: string;
}) {
  return (
    <section aria-label={title}>
      <h3>{title}</h3>
      {items.length ? (
        <ul>
          {items.map((item) => (
            <li key={item.key}>
              <span>{item.text}</span>
              {item.at && (
                <time dateTime={item.at}>
                  Actividad del {new Date(item.at).toLocaleDateString('es-ES')}
                </time>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-text-muted">{empty}</p>
      )}
    </section>
  );
}

/** Render the server projection literally. No work-state computation belongs here. */
export function ProjectSummaryContent({ summary }: { summary: ProjectSummary }) {
  const cost = summary.cost;
  return (
    <div className="project-summary-content">
      <h2>{summary.name}</h2>
      <SummaryList
        title="Qué estamos construyendo"
        items={summary.goals}
        empty="El objetivo aparecerá aquí cuando esté disponible en una idea o especificación."
      />
      {!!summary.notices.length && (
        <div role="status">
          {summary.notices.map((notice) => (
            <p key={notice}>{notice}</p>
          ))}
        </div>
      )}
      <SummaryList
        title="Decisiones que te esperan"
        items={summary.decisions}
        empty="Sin decisiones pendientes registradas."
      />
      <section aria-label="Progreso por funcionalidad">
        <h3>Progreso por funcionalidad</h3>
        {summary.features.length ? (
          <ul className="project-summary-features">
            {summary.features.map((feature) => (
              <li key={feature.key}>
                <div>
                  <strong>{feature.title ?? feature.key}</strong>{' '}
                  <span className="text-text-muted">{feature.key}</span>{' '}
                  <StatusChip state={feature.state} />
                </div>
                <p>
                  {feature.done} {feature.done === 1 ? 'hecha' : 'hechas'} · {feature.inProgress} en
                  curso · {feature.pending} {feature.pending === 1 ? 'pendiente' : 'pendientes'}
                </p>
                {feature.cancelled > 0 && (
                  <p>
                    {feature.cancelled}{' '}
                    {feature.cancelled === 1 ? 'tarea cancelada' : 'tareas canceladas'}
                  </p>
                )}
                {feature.total === 0 && (
                  <p className="text-text-muted">Sin tareas de implementación registradas.</p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p>
            Las funcionalidades y su progreso aparecerán aquí al preparar los requisitos y las
            tareas de una Nueva idea.
          </p>
        )}
      </section>
      <SummaryList
        title="Hitos alcanzados"
        items={summary.milestones}
        empty="Todavía no hay hitos registrados."
      />
      <SummaryList
        title="Últimas entregas y trabajo terminado"
        items={summary.deliveries}
        empty="Todavía no hay entregas registradas."
      />
      <SummaryList
        title="Riesgos registrados"
        items={summary.risks}
        empty="Sin riesgos registrados en las ideas y especificaciones disponibles."
      />
      <SummaryList title="Bloqueos" items={summary.blockers} empty="Sin bloqueos registrados." />
      <section aria-label="Coste y consumo">
        <h3>Coste y consumo</h3>
        {cost.executions === 0 ? (
          <p>Sin datos de coste o consumo registrados.</p>
        ) : (
          <>
            <p>Coste registrado · {featureCostLabel(cost)}</p>
            <p>
              Cobertura del coste · {cost.costKnown} de {cost.executions} ejecuciones registradas
            </p>
            <p>Tokens de entrada · {cost.inputTokens?.toLocaleString('es-ES') ?? 'sin datos'}</p>
            <p>Tokens de salida · {cost.outputTokens?.toLocaleString('es-ES') ?? 'sin datos'}</p>
            {cost.tokenKnown !== null && (
              <p>
                Cobertura de entrada · {cost.tokenKnown} de {cost.executions} ejecuciones
                registradas
              </p>
            )}
            {cost.source === 'retained_telemetry' && (
              <p>Consumo limitado al historial de telemetría conservado.</p>
            )}
            {cost.source === 'ledger' && (
              <p className="text-text-muted">
                El coste conserva la estimación API registrada en cada ejecución.
              </p>
            )}
          </>
        )}
      </section>
      <SummaryList
        title="Próximos pasos"
        items={summary.nextSteps}
        empty="Crea una Nueva idea desde la barra de la oficina para definir qué construir."
      />
    </div>
  );
}

export function ProjectSummaryPanel({
  isOpen,
  onClose,
  onNavigate,
  onWorkflowStage,
  hosted = false,
}: {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (tab: PanelTab) => void;
  onWorkflowStage: (id: WorkflowStageId) => void;
  hosted?: boolean;
}) {
  const { projectId, connection, store, snapshot, refresh } = useProjectSummary(isOpen);
  if (!isOpen) return null;
  return (
    <section
      role="region"
      aria-label="Resumen del proyecto"
      data-testid="project-summary-panel"
      className="read-only-panel project-summary p-10"
    >
      <PanelHeading hosted={hosted} title="Proyecto" onClose={onClose}>
        <Button
          size="sm"
          disabled={!projectId || connection !== 'connected' || store.phase === 'loading'}
          onClick={refresh}
        >
          Actualizar
        </Button>
      </PanelHeading>
      {snapshot?.summary && (
        <ProjectWorkflow stages={snapshot.summary.workflow} onSelect={onWorkflowStage} />
      )}
      {connection !== 'connected' ? (
        <p role="status">El resumen estará disponible al recuperar la conexión.</p>
      ) : !projectId ? (
        <>
          <p>{PROJECT_EMPTY_TEXT}</p>
          <p>
            Crea una Nueva idea desde la barra de la oficina para preparar el proyecto. Aquí
            aparecerán su objetivo, progreso, entregas y próximos pasos.
          </p>
        </>
      ) : !snapshot ? (
        <p role="status">Cargando el resumen del proyecto…</p>
      ) : snapshot.status === 'denied' ? (
        <p role="alert">
          Acceso denegado al resumen del proyecto. Abre la oficina con el acceso del operador.
        </p>
      ) : snapshot.status === 'unknown_project' ? (
        <p role="alert">El proyecto seleccionado ya no está vinculado a esta oficina.</p>
      ) : snapshot.status === 'read_error' ? (
        <div role="alert">
          <p>No se pudo leer el resumen. {featuresReasonText(snapshot.reason)}</p>
          <Button onClick={refresh}>Reintentar</Button>
        </div>
      ) : snapshot.status === 'empty' && snapshot.summary ? (
        <div className="project-summary-content">
          <h2>{snapshot.summary.name}</h2>
          <p>Crea una Nueva idea desde la barra de la oficina para definir qué construir.</p>
          <p>
            Aquí aparecerán el objetivo de la app, el progreso de sus funcionalidades, las entregas,
            las decisiones, los riesgos y los próximos pasos.
          </p>
          <p>Sin datos de coste o consumo registrados.</p>
          {snapshot.summary.notices.map((notice) => (
            <p role="status" key={notice}>
              {notice}
            </p>
          ))}
        </div>
      ) : (
        snapshot.summary && <ProjectSummaryContent summary={snapshot.summary} />
      )}
      <nav aria-label="Ver detalles del proyecto" className="flex flex-wrap gap-8">
        <Button size="sm" onClick={() => onNavigate('features')}>
          Ver funcionalidades
        </Button>
        <Button size="sm" onClick={() => onNavigate('backlog')}>
          Ver trabajo
        </Button>
        <Button size="sm" onClick={() => onNavigate('decisions')}>
          Ver decisiones
        </Button>
      </nav>
      {projectId && <GithubHostingWizard key={projectId} projectId={projectId} />}
    </section>
  );
}
