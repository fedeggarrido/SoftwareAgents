import type { AutonomyLevel } from '../../core/src/project.js';

export type PolicyActor = 'human' | 'agent' | 'system';
export type PolicyOutcome = 'allow' | 'require_human' | 'deny';
export interface PolicyDecision {
  outcome: PolicyOutcome;
  reason: string;
}

/** Minimum autonomous level; null means an unconditional human gate.
 * A0 observes, A1 proposes, A2 executes reversible work, A3 manages routine
 * project work, A4 retains the same mandatory human gates. Other permission,
 * path, command, quota and review checks still apply after an allow.
 */
export const POLICY_ACTIONS = Object.freeze({
  launch_execution: 'A2',
  autopilot_toggle: 'A3',
  answer_decision: null,
  approve_featurespec: null,
  create_branch: 'A2',
  push_branch: 'A2',
  open_draft_pr: 'A2',
  merge_pr: null,
  push_main: null,
  bypass_permissions: null,
  change_autonomy: null,
  use_new_secret: null,
  clickup_write: 'A3',
  delete_worktree: null,
  touch_protected_path: null,
} as const);
export type PolicyAction = keyof typeof POLICY_ACTIONS;

const LEVELS: readonly AutonomyLevel[] = ['A0', 'A1', 'A2', 'A3', 'A4'];

/** Pure: callers must supply loadProjectConfig(...).operator.autonomyLevel,
 * never a level from a message, AgentSpec, board or repository manifest.
 * System actors have no implicit human authority. Agents cannot perform any
 * autonomy change, including raising their own level. Human means the current
 * request is authenticated as an operator, not that an agent claims approval.
 */
export function evaluatePolicy(
  action: PolicyAction,
  actor: PolicyActor,
  autonomyLevel: AutonomyLevel,
): PolicyDecision {
  if (
    !Object.hasOwn(POLICY_ACTIONS, action) ||
    !['human', 'agent', 'system'].includes(actor) ||
    !LEVELS.includes(autonomyLevel)
  ) {
    return { outcome: 'deny', reason: 'Acción, actor o nivel de autonomía inválido.' };
  }
  if (actor === 'agent' && (action === 'push_main' || action === 'bypass_permissions')) {
    return { outcome: 'deny', reason: `${action} está prohibido para agentes en cualquier nivel.` };
  }
  if (actor === 'human') {
    return { outcome: 'allow', reason: `${action} solicitado por el operador humano autenticado.` };
  }
  const minimum = POLICY_ACTIONS[action];
  if (minimum === null) {
    return { outcome: 'require_human', reason: `${action} requiere siempre intervención humana.` };
  }
  if (LEVELS.indexOf(autonomyLevel) < LEVELS.indexOf(minimum)) {
    return {
      outcome: 'require_human',
      reason: `${action} requiere ${minimum}; el operador ha configurado ${autonomyLevel}.`,
    };
  }
  return {
    outcome: 'allow',
    reason: `${action} permitido por el nivel ${autonomyLevel} del operador.`,
  };
}
