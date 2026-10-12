import { describe, expect, it } from 'vitest';

import type { AutonomyLevel } from '../../core/src/project.js';
import {
  evaluatePolicy,
  POLICY_ACTIONS,
  type PolicyAction,
  type PolicyActor,
  type PolicyOutcome,
} from '../src/policy.js';

const levels: AutonomyLevel[] = ['A0', 'A1', 'A2', 'A3', 'A4'];
const actors: PolicyActor[] = ['human', 'agent', 'system'];
// Independent expected matrix, ordered A0 through A4, for non-human actors.
const gate: PolicyOutcome[] = Array(5).fill('require_human');
const reversible: PolicyOutcome[] = ['require_human', 'require_human', 'allow', 'allow', 'allow'];
const routine: PolicyOutcome[] = [
  'require_human',
  'require_human',
  'require_human',
  'allow',
  'allow',
];
const expected: Record<PolicyAction, PolicyOutcome[]> = {
  launch_execution: reversible,
  autopilot_toggle: routine,
  answer_decision: gate,
  approve_featurespec: gate,
  create_branch: reversible,
  push_branch: reversible,
  open_draft_pr: reversible,
  merge_pr: gate,
  push_main: gate,
  bypass_permissions: gate,
  change_autonomy: gate,
  change_executor_availability: gate,
  use_new_secret: gate,
  clickup_write: routine,
  delete_worktree: gate,
  touch_protected_path: gate,
};

describe('deterministic policy', () => {
  const cases = (Object.keys(expected) as PolicyAction[]).flatMap((action) =>
    actors.flatMap((actor) =>
      levels.map((level, index) => ({
        action,
        actor,
        level,
        outcome:
          actor === 'human'
            ? 'allow'
            : actor === 'agent' && ['push_main', 'bypass_permissions'].includes(action)
              ? 'deny'
              : expected[action][index],
      })),
    ),
  );
  it('covers the complete action catalogue', () => {
    expect(Object.keys(expected).sort()).toEqual(Object.keys(POLICY_ACTIONS).sort());
    expect(cases).toHaveLength(240);
  });
  it.each(cases)('$action / $actor / $level => $outcome', ({ action, actor, level, outcome }) => {
    const decision = evaluatePolicy(action, actor, level);
    expect(decision.outcome).toBe(outcome);
    expect(decision.reason.trim().length).toBeGreaterThan(0);
    expect(evaluatePolicy(action, actor, level)).toEqual(decision);
  });
  it.each([
    ['unknown', 'human', 'A4'],
    ['toString', 'human', 'A4'],
    ['create_branch', 'unknown', 'A4'],
    ['create_branch', 'human', 'A5'],
  ])('fails closed for invalid runtime inputs %s / %s / %s', (action, actor, level) => {
    expect(
      evaluatePolicy(action as PolicyAction, actor as PolicyActor, level as AutonomyLevel).outcome,
    ).toBe('deny');
  });
});
