import type { FeaturePlanSnapshot } from '../../../core/src/messages.js';

export function planDecisionText(snapshot: FeaturePlanSnapshot): string {
  const state = snapshot.plan?.approvalState;
  if (state === 'merged') return 'Feature integrada. No necesita aprobación del plan.';
  if (state === 'finished') return 'Feature finalizada. No necesita aprobación del plan.';
  if (state === 'approved') return 'Esta revisión del plan ya está aprobada.';
  const revision =
    state === 'changed'
      ? 'El plan cambió después de la aprobación. Revisa la nueva revisión.'
      : state === 'unbound'
        ? 'FeatureSpec aprobada. Esta revisión del plan todavía no tiene aprobación registrada.'
        : 'Plan pendiente de aprobación humana.';
  switch (snapshot.approvalBlock) {
    case 'read_only':
      return `${revision} Solo lectura. La conexión no tiene privilegios del operador.`;
    case 'managed_process':
      return `${revision} Aprobación bloqueada porque el servidor se ejecuta como proceso gestionado, incluso con token del operador.`;
    case 'unsupported_adapter':
      return `${revision} Este adapter no admite aprobar planes. Abre la oficina standalone.`;
    case 'stale_revision':
      return 'La revisión mostrada está desactualizada. Actualiza y revisa el plan antes de aprobar.';
    case 'unavailable':
      return 'No se puede confirmar el estado de aprobación. Actualiza el plan.';
    default:
      return snapshot.canApprove
        ? revision
        : `${revision} La aprobación no está disponible en esta conexión.`;
  }
}

export const PLAN_MISSING_COPY = {
  requirements: 'Este plan no incluye requisitos',
  architecture: 'Este plan no incluye arquitectura',
  tasks: 'Este plan no incluye tareas',
  tests: 'Este plan no incluye pruebas',
  ci: 'Este plan no incluye integración continua',
  security: 'Este plan no incluye seguridad',
  documentation: 'Este plan no incluye documentación',
} as const;
