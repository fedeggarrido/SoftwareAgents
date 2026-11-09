import { FEATURE_PLAN_SECTIONS } from '../../../core/src/featurePlan.js';
import type { FeaturePlanSnapshot } from '../../../core/src/messages.js';

/** Protocol fixture shared by rendering and browser layout regressions. */
export const planSnapshot = (requestId: string, canApprove = true): FeaturePlanSnapshot => ({
  type: 'featurePlanSnapshot',
  projectId: 'P',
  key: 'FEAT-001',
  requestId,
  canApprove,
  approvalBlock: canApprove ? null : 'read_only',
  errorCode: null,
  plan: {
    key: 'FEAT-001',
    title: '<script>alert(1)</script>',
    revision: 'a'.repeat(64),
    specSha: 'b'.repeat(40),
    specApproved: false,
    approved: false,
    approvalState: 'pending',
    summary: {
      goal: 'Leer el plan antes de aprobar',
      userValue: 'Entender el trabajo propuesto',
      outOfScope: ['No cambiar permisos'],
      risks: ['<img src=x onerror=alert(1)>'],
      acceptance: ['AC-001 · El resumen muestra los títulos'],
      tasks: [
        { key: 'FEAT-001-T01', title: 'Crear resumen', size: 'M', dependencies: [] },
        {
          key: 'FEAT-001-T02',
          title: 'Mostrar resumen',
          size: 'S',
          dependencies: ['Crear resumen'],
        },
      ],
    },
    sections: FEATURE_PLAN_SECTIONS.map((section) => ({
      ...section,
      content:
        section.id === 'requirements'
          ? 'apiVersion: softwareagents.io/v1alpha1\nkind: FeatureSpec\ntitle: <img src=x onerror=alert(1)>\n[enlace](javascript:alert(1))'
          : null,
      items:
        section.id === 'requirements'
          ? ['Mostrar el plan como texto']
          : section.id === 'tasks'
            ? ['Crear resumen', 'Mostrar resumen']
            : [],
    })),
  },
});
