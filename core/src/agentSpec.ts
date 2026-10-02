/** Requested permission ceiling; external Operator policy must authorize and enforce it. */
export type AgentPermissionProfile = 'read_only' | 'brain_write' | 'branch_write';

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
