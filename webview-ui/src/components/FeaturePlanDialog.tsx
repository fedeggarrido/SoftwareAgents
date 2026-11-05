import { useEffect, useState, useSyncExternalStore } from 'react';

import type { PlanView } from '../office/featurePlanController.js';
import { FeaturePlanController } from '../office/featurePlanController.js';
import { transport } from '../transport/index.js';
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
  return (
    <Modal isOpen onClose={onClose} title="Plan de feature" className="feature-plan-dialog">
      <div
        className="p-10 flex flex-col gap-8 text-xs"
        role="region"
        aria-label={`Plan de ${featureKey}`}
      >
        <h2>
          {featureKey} {plan?.title}
        </h2>
        {view.notice && <p role="status">{view.notice}</p>}
        {view.loading && <p role="status">Cargando plan…</p>}
        {plan && (
          <>
            <p>
              Revisión de la especificación <code>{plan.specSha}</code>
            </p>
            {plan.sections.map((section) => (
              <section key={section.id} aria-label={section.title}>
                <h3>{section.title}</h3>
                {section.content === null ? (
                  <p className="text-text-muted">Sección ausente</p>
                ) : (
                  <pre>{section.content}</pre>
                )}
              </section>
            ))}
            {plan.specApproved && !plan.approved && (
              <p>FeatureSpec aprobada; este plan ha cambiado y no está aprobado</p>
            )}
            {plan.approved ? (
              <p>Plan aprobado</p>
            ) : snapshot.canApprove ? (
              <Button disabled={view.pending} onClick={onApprove}>
                {view.pending ? 'Aprobando…' : 'Aprobar plan'}
              </Button>
            ) : (
              <p>Solo lectura. La aprobación requiere una conexión privilegiada del operador.</p>
            )}
          </>
        )}
        <Button size="sm" disabled={view.loading || view.pending} onClick={onRefresh}>
          Actualizar plan
        </Button>
      </div>
    </Modal>
  );
}
