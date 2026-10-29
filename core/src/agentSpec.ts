/** Requested permission ceiling; external Operator policy must authorize and enforce it. */
export type AgentPermissionProfile = 'read_only' | 'brain_write' | 'branch_write';

/** Phase 1 visual review has the same read-only ceiling as code review. */
export const PRODUCT_DESIGNER_SPEC: AgentSpec = {
  apiVersion: 'softwareagents.io/v1alpha1',
  kind: 'AgentSpec',
  metadata: {
    id: 'product-designer',
    version: '1.0.0',
    displayName: 'Principal Product Designer',
    department: 'design',
  },
  identity: {
    role: 'product-designer',
    mission: 'Critically review real product captures with actionable visual and UX findings.',
    principles: [
      'Never claim validation that was not executed',
      'Respect product context and accessibility',
    ],
    antiPatterns: ['Generic AI aesthetics', 'Invented evidence'],
  },
  outputs: ['DesignReport'],
  permissions: { profile: 'read_only' },
  modelPolicy: { capabilityClass: 'review', fallbackAllowed: false },
  context: { brainPaths: [] },
  gates: { mayBlock: ['visual_regression', 'accessibility_regression'] },
  escalation: { humanRequired: ['art_direction', 'permission_expansion'] },
};

/** Versioned role declaration, independent of Model, Executor and operator autonomy. */
export interface AgentSpec {
  apiVersion: 'softwareagents.io/v1alpha1';
  kind: 'AgentSpec';
  metadata: { id: string; version: string; displayName: string; department: string };
  identity: { role: string; mission: string; principles: string[]; antiPatterns: string[] };
  outputs: string[];
  permissions: { profile: AgentPermissionProfile };
  modelPolicy: { capabilityClass: string; fallbackAllowed: boolean };
  /** Declarative Project Brain paths; consumers must enforce containment before reading. */
  context: { brainPaths: string[] };
  gates: { mayBlock: string[] };
  escalation: { humanRequired: string[] };
}
