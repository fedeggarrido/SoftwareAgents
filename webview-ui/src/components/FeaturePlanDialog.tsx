import { useEffect, useId, useState, useSyncExternalStore } from 'react';

import { FEATURE_PLAN_PREVIEW_ITEMS, FEATURE_PLAN_REVISION_CHARS } from '../constants.js';
import type { PlanView } from '../office/featurePlanController.js';
import { FeaturePlanController } from '../office/featurePlanController.js';
import { PLAN_MISSING_COPY, planDecisionText } from '../office/featurePlanPresentation.js';
import { transport } from '../transport/index.js';
import { StatusChip } from './StatusChip.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

export function FeaturePlanButton({
  projectId,
  featureKey,
}: {
  projectId: string;
  featureKey: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Ver plan
      </Button>
      {open && (
        <FeaturePlanDialog
          projectId={projectId}
          featureKey={featureKey}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function FeaturePlanDialog({
  projectId,
  featureKey,
  onClose,
}: {
  projectId: string;
  featureKey: string;
  onClose: () => void;
}) {
  const [controller] = useState(() => new FeaturePlanController(transport, projectId, featureKey));
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => controller.start(), [controller]);
  return (
    <FeaturePlanView
      featureKey={featureKey}
      view={view}
      onClose={onClose}
      onApprove={controller.approve}
      onRefresh={controller.refresh}
    />
  );
}

export function FeaturePlanView({
  featureKey,
  view,
  onClose,
  onApprove,
  onRefresh,
}: {
  featureKey: string;
  view: PlanView;
  onClose: () => void;
  onApprove: () => void;
  onRefresh: () => void;
}) {
  const snapshot = view.snapshot;
  const plan = snapshot?.plan;
  const id = useId();
  const target = (section: string) => `${id}-${section}`;
  const missing = plan?.sections.filter((section) => section.items.length === 0) ?? [];
  const finished = plan?.approvalState === 'finished' || plan?.approvalState === 'merged';
  return (
    <Modal isOpen onClose={onClose} title="Plan de funcionalidad" className="feature-plan-dialog">
      <div className="feature-plan-layout" role="region" aria-label={`Plan de ${featureKey}`}>
        {plan && (
          <nav className="feature-plan-nav" aria-label="Secciones del plan">
            <a href={`#${target('summary')}`}>Resumen</a>
            {plan.sections.map((section) => (
              <a key={section.id} href={`#${target(section.id)}`}>
                {section.title}
              </a>
            ))}
          </nav>
        )}
        <div className="feature-plan-scroll" tabIndex={0} aria-label="Contenido del plan">
          {view.loading && <p role="status">Cargando plan…</p>}
          {plan && (
            <>
              <section id={target('summary')} tabIndex={-1} aria-labelledby={target('title')}>
                <h2 id={target('title')}>
                  {featureKey} {plan.title}
                </h2>
                <StatusChip state={plan.approvalState} />
                <p className="feature-plan-goal">{plan.summary.goal}</p>
                <p className="feature-plan-value">{plan.summary.userValue}</p>
                <div className="feature-plan-summary">
                  <div>
                    <h3>Fuera de alcance</h3>
                    <PlanList
                      items={plan.summary.outOfScope.slice(0, FEATURE_PLAN_PREVIEW_ITEMS)}
                      empty="Sin exclusiones explícitas en las reglas."
                    />
                    <a href={`#${target('requirements')}`}>Ver reglas completas</a>
                  </div>
                  <div>
                    <h3>Riesgos</h3>
                    <PlanList
                      items={plan.summary.risks.slice(0, FEATURE_PLAN_PREVIEW_ITEMS)}
                      empty="Sin riesgos declarados."
                    />
                    <a href={`#${target('architecture')}`}>Ver todos los riesgos</a>
                  </div>
                  <div>
                    <h3>{plan.summary.tasks.length} tareas</h3>
                    <PlanList
                      items={plan.summary.tasks
                        .slice(0, FEATURE_PLAN_PREVIEW_ITEMS)
                        .map((task) => task.title)}
                      empty="Sin tareas declaradas."
                    />
                    <a href={`#${target('tasks')}`}>Ver todas las tareas</a>
                  </div>
                  <div>
                    <h3>Cómo se comprobará</h3>
                    <PlanList
                      items={plan.summary.acceptance.slice(0, FEATURE_PLAN_PREVIEW_ITEMS)}
                      empty="Sin criterios declarados."
                    />
                    <a href={`#${target('requirements')}`}>
                      {plan.summary.acceptance.length} criterios completos
                    </a>
                    <a href={`#${target('tests')}`}>Ver pruebas</a>
                  </div>
                  <div>
                    <h3>Coste estimado</h3>
                    <p>Sin datos de estimación en el plan.</p>
                  </div>
                </div>
              </section>
              {plan.sections.map((section) => (
                <section
                  key={section.id}
                  id={target(section.id)}
                  tabIndex={-1}
                  aria-labelledby={target(`${section.id}-title`)}
                >
                  <h3 id={target(`${section.id}-title`)}>{section.title}</h3>
                  {section.id === 'tasks' && plan.summary.tasks.length > 0 ? (
                    <ol className="feature-plan-tasks">
                      {plan.summary.tasks.map((task) => (
                        <li key={task.key}>
                          <h4>{task.title}</h4>
                          <p>
                            Tamaño {task.size} · {task.key}
                          </p>
                          <p>
                            Depende de{' '}
                            {task.dependencies.length
                              ? task.dependencies.join(', ')
                              : 'ninguna tarea'}
                          </p>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <PlanList
                      items={section.items}
                      empty="Sin contenido declarado. Consulta los avisos junto a la decisión."
                    />
                  )}
                  {section.id === 'architecture' && (
                    <PlanList items={plan.summary.risks} empty="Sin riesgos declarados." />
                  )}
                  {section.content !== null && (
                    <details>
                      <summary>
                        Ver detalle técnico<span className="sr-only"> de {section.title}</span>
                      </summary>
                      <pre>{section.content}</pre>
                    </details>
                  )}
                </section>
              ))}
            </>
          )}
        </div>
        <footer className="feature-plan-decision" aria-label="Decisión sobre el plan">
          {missing.length > 0 && (
            <ul className="feature-plan-warnings" aria-label="Avisos del plan">
              {missing.map((section) => (
                <li key={section.id}>
                  {PLAN_MISSING_COPY[section.id]}
                  {finished
                    ? '.'
                    : section.id === 'tests'
                      ? '. Aprobar sin ellas es tu decisión.'
                      : '. Aprobar con esta ausencia es tu decisión.'}
                </li>
              ))}
            </ul>
          )}
          {view.notice && <p role="status">{view.notice}</p>}
          {snapshot?.plan && <p role="status">{planDecisionText(snapshot)}</p>}
          <div className="feature-plan-actions">
            {plan && (
              <span tabIndex={0} title={plan.revision} aria-label={`Revisión ${plan.revision}`}>
                Revisión {plan.revision.slice(0, FEATURE_PLAN_REVISION_CHARS)}
              </span>
            )}
            <Button size="sm" disabled={view.loading || view.pending} onClick={onRefresh}>
              Actualizar plan
            </Button>
            {plan && !finished && !plan.approved && (
              <Button disabled={view.pending || !snapshot?.canApprove} onClick={onApprove}>
                {view.pending ? 'Aprobando…' : 'Aprobar plan'}
              </Button>
            )}
          </div>
        </footer>
      </div>
    </Modal>
  );
}

function PlanList({ items, empty }: { items: string[]; empty: string }) {
  return items.length ? (
    <ul>
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  ) : (
    <p>{empty}</p>
  );
}
