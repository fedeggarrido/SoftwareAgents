import { describe, expect, it } from 'vitest';

import type { HumanDecision } from '../../core/src/humanDecision.js';
import type {
  FeaturePlanApprovalState,
  FeatureRow,
  WorkflowStageId,
} from '../../core/src/messages.js';
import { type FeaturesSource, projectFeatures } from '../src/featuresView.js';
import { projectWorkflow } from '../src/projectWorkflow.js';
import type { TaskStatus } from '../src/workstore/taskStateMachine.js';

function source(): FeaturesSource {
  return {
    features: [],
    tasks: [],
    designs: [],
    decisions: [],
    runs: [],
    executions: [],
    events: [],
  };
}
function task(key: string, status: TaskStatus, feature_key: string | null = null) {
  return { key, status, feature_key, version: 3, priority: 0, updated_at: '2026-11-01' };
}
function project(
  data: FeaturesSource,
  ideas: string[] = [],
  approvals: { key: string; state: FeaturePlanApprovalState }[] = [],
  decisions: HumanDecision[] = [],
) {
  return projectWorkflow(data, projectFeatures(data), { ideas, approvals }, decisions);
}
function stage(data: FeaturesSource, id: WorkflowStageId) {
  return project(data).find((stage) => stage.id === id);
}

describe('project workflow policy', () => {
  it('keeps eight ordered empty stages for a new Project', () => {
    const stages = project(source());
    expect(stages.map((stage) => stage.label)).toEqual([
      'Idea',
      'Requisitos',
      'Plan',
      'Aprobación',
      'Desarrollo',
      'QA',
      'Revisión',
      'Entrega',
    ]);
    for (const stage of stages)
      expect(stage).toMatchObject({
        state: 'workflow_empty',
        taskKeys: [],
        featureKeys: [],
        agents: [],
      });
  });

  it('uses pending idea ids and plan approval states from the existing summary context', () => {
    const data = source();
    expect(project(data, ['FEAT-001'])[0]).toMatchObject({
      state: 'workflow_human',
      featureKeys: ['FEAT-001'],
      taskKeys: [],
    });
    data.features = [{ key: 'FEAT-002', status: 'approved' }];
    data.designs = [{ feature_key: 'FEAT-002' }];
    for (const state of ['pending', 'changed', 'unbound'] satisfies FeaturePlanApprovalState[]) {
      expect(project(data, [], [{ key: 'FEAT-002', state }])[3]).toMatchObject({
        state: 'workflow_human',
        featureKeys: ['FEAT-002'],
      });
    }
    expect(project(data, [], [{ key: 'FEAT-002', state: 'approved' }])[4].state).toBe(
      'workflow_active',
    );
  });

  it.each([
    ['FEAT-001-REQUIREMENTS', 'RUNNING', 'requirements'],
    ['FEAT-001-DESIGN', 'RUNNING', 'plan'],
    ['task', 'RUNNING', 'development'],
    ['task', 'QA', 'qa'],
    ['task', 'REVIEW', 'review'],
    ['task', 'DONE', 'delivery'],
  ] satisfies [string, TaskStatus, WorkflowStageId][])(
    'places %s / %s in %s',
    (key, status, id) => {
      const data = source();
      data.tasks = [task(key, status)];
      expect(stage(data, id)).toMatchObject({
        state: status === 'DONE' ? 'workflow_done' : 'workflow_active',
        taskKeys: [key],
        agents: [],
      });
    },
  );

  it.each(['DRAFT', 'READY', 'QUEUED', 'LEASED', 'RUNNING', 'REVIEW', 'QA'] satisfies TaskStatus[])(
    'projects %s as active work',
    (status) => {
      const data = source();
      data.tasks = [task('work', status)];
      expect(project(data).filter((stage) => stage.state === 'workflow_active')).toHaveLength(1);
    },
  );

  it.each(['WAITING_QUOTA', 'BLOCKED', 'FAILED_RETRYABLE', 'FAILED_FINAL'] satisfies TaskStatus[])(
    'projects %s as blocked and gives impediments precedence',
    (status) => {
      const data = source();
      data.tasks = [
        task('blocked', status),
        task('active', 'RUNNING'),
        task('human', 'WAITING_HUMAN'),
      ];
      expect(stage(data, 'development')).toMatchObject({
        state: 'workflow_blocked',
        taskKeys: ['blocked', 'active', 'human'],
      });
    },
  );

  it('distinguishes human waits, completed work and cancelled work', () => {
    const data = source();
    data.tasks = [
      task('human', 'WAITING_HUMAN'),
      task('done', 'DONE'),
      task('cancelled', 'CANCELLED'),
    ];
    expect(stage(data, 'development')?.state).toBe('workflow_human');
    expect(stage(data, 'delivery')).toMatchObject({ state: 'workflow_done', taskKeys: ['done'] });
  });

  it('retains completed preparation stages and recorded QA evidence', () => {
    const data = source();
    data.features = [{ key: 'FEAT-001', status: 'approved' }];
    data.designs = [{ feature_key: 'FEAT-001' }];
    data.tasks = [
      task('FEAT-001-REQUIREMENTS', 'DONE', 'FEAT-001'),
      task('FEAT-001-DESIGN', 'DONE', 'FEAT-001'),
      task('FEAT-001-T01', 'DONE', 'FEAT-001'),
    ];
    data.events = [
      { task_key: 'FEAT-001-T01', from_status: 'QA', to_status: 'DONE', created_at: '2026-11-02' },
    ];
    const result = project(data, [], [{ key: 'FEAT-001', state: 'approved' }]);
    for (const id of ['idea', 'requirements', 'plan', 'approval', 'qa'] satisfies WorkflowStageId[])
      expect(result.find((stage) => stage.id === id)?.state).toBe('workflow_done');
    expect(result.find((stage) => stage.id === 'requirements')?.taskKeys).toEqual([
      'FEAT-001-REQUIREMENTS',
    ]);
  });

  it('counts tasks and distinct features and shows only real current sessions', () => {
    const data = source();
    data.features = [{ key: 'FEAT-001', status: 'approved' }];
    data.designs = [{ feature_key: 'FEAT-001' }];
    data.tasks = [
      task('FEAT-001-T01', 'RUNNING', 'FEAT-001'),
      task('FEAT-001-T02', 'RUNNING', 'FEAT-001'),
      task('FEAT-001-T03', 'DONE', 'FEAT-001'),
    ];
    data.executions = [
      {
        task_key: 'FEAT-001-T01',
        task_version: 3,
        started_at: '2026-11-01',
        session_id: 'real-session',
        agent_role: 'developer',
      },
      {
        task_key: 'FEAT-001-T02',
        task_version: 2,
        started_at: '2026-11-02',
        session_id: 'old-session',
        agent_role: 'reviewer',
      },
      {
        task_key: 'FEAT-001-T03',
        task_version: 3,
        started_at: '2026-11-02',
        session_id: 'finished-session',
      },
    ];
    expect(stage(data, 'development')).toMatchObject({
      taskKeys: ['FEAT-001-T01', 'FEAT-001-T02', 'FEAT-001-T03'],
      featureKeys: ['FEAT-001'],
      agents: ['real-session'],
    });
    data.executions[0].tree_closed_at = '2026-11-02';
    expect(stage(data, 'development')?.agents).toEqual([]);
  });

  it('uses the execution step for concurrent tasks and preserves the blocked QA stage from domain events', () => {
    const data = source();
    data.tasks = [task('review', 'RUNNING'), task('qa', 'BLOCKED')];
    data.executions = [
      {
        task_key: 'review',
        task_version: 3,
        started_at: '2026-11-01',
        agent_role: 'reviewer',
        session_id: 'review-session',
      },
    ];
    data.events = [
      { task_key: 'qa', from_status: 'QA', to_status: 'BLOCKED', created_at: '2026-11-02' },
    ];
    expect(stage(data, 'review')).toMatchObject({
      state: 'workflow_active',
      agents: ['review-session'],
    });
    expect(stage(data, 'qa')).toMatchObject({ state: 'workflow_blocked', taskKeys: ['qa'] });
  });

  it('keeps interrupted executions in their lease window and excludes a previous review on retry', () => {
    const data = source();
    data.tasks = [task('work', 'BLOCKED')];
    data.tasks[0].version = 5;
    data.events = [
      {
        task_key: 'work',
        from_status: 'REVIEW',
        to_status: 'RUNNING',
        task_version: 4,
        created_at: '2026-11-01',
      },
      {
        task_key: 'work',
        from_status: 'RUNNING',
        to_status: 'BLOCKED',
        task_version: 5,
        created_at: '2026-11-02',
      },
    ];
    data.executions = [
      {
        task_key: 'work',
        task_version: 4,
        started_at: '2026-11-01',
        agent_role: 'reviewer',
        session_id: 'review-session',
      },
    ];
    expect(stage(data, 'review')).toMatchObject({
      state: 'workflow_blocked',
      taskKeys: ['work'],
      agents: [],
    });
    data.tasks[0].status = 'READY';
    expect(stage(data, 'development')).toMatchObject({
      state: 'workflow_active',
      taskKeys: ['work'],
      agents: [],
    });
    data.tasks[0].status = 'LEASED';
    data.tasks[0].version = 6;
    data.events.push({
      task_key: 'work',
      from_status: 'QUEUED',
      to_status: 'LEASED',
      task_version: 6,
      created_at: '2026-11-03',
    });
    expect(stage(data, 'development')?.agents).toEqual([]);
    expect(stage(data, 'review')?.taskKeys).toEqual([]);
  });

  it('projects spec approval, question gates and integration evidence from FeatureRow', () => {
    const data = source();
    data.features = [{ key: 'FEAT-001', status: 'in_review' }];
    expect(stage(data, 'approval')?.state).toBe('workflow_human');
    const feature: FeatureRow = {
      ...projectFeatures(data)[0],
      gates: [{ kind: 'requirements_questions', task: null, expired: true, command: '' }],
    };
    expect(projectWorkflow(data, [feature], { ideas: [], approvals: [] }, [])[1]).toMatchObject({
      state: 'workflow_human',
      featureKeys: ['FEAT-001'],
    });
    expect(projectWorkflow(data, [feature], { ideas: [], approvals: [] }, [])[3].state).toBe(
      'workflow_empty',
    );
    data.features[0].status = 'ready_to_merge';
    data.tasks = [task('FEAT-001-T01', 'DONE', 'FEAT-001')];
    data.tasks[0].declaration = '{}';
    expect(stage(data, 'delivery')?.state).toBe('workflow_human');
    data.runs = [
      {
        feature_key: 'FEAT-001',
        state: { branch: 'sa/FEAT-001-integration', head: 'a'.repeat(40) },
      },
    ];
    data.mainAncestors = new Set(['a'.repeat(40)]);
    expect(stage(data, 'delivery')?.state).toBe('workflow_done');
  });

  it('uses unresolved task and feature decisions and excludes answered decisions', () => {
    const data = source();
    data.tasks = [task('work', 'READY', 'FEAT-001')];
    const decision: HumanDecision = {
      id: 'decision',
      context: 'Revisar',
      options: [],
      recommendation: '',
      disagreement: [],
      impact: '',
      urgency: 'high',
      requestedBy: 'developer',
      blocks: ['FEAT-001'],
      status: 'expired',
      answeredBy: null,
      answeredAt: null,
    };
    expect(project(data, [], [], [decision])[4].state).toBe('workflow_human');
    expect(project(data, [], [], [{ ...decision, status: 'answered' }])[4].state).toBe(
      'workflow_active',
    );
    data.tasks[0].status = 'INVALID';
    expect(() => project(data)).toThrow('invalid_data');
  });
});
