import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  BoardItem,
  ProjectSummarySnapshot,
  WorkflowStage,
  WorkflowStageId,
} from '../../core/src/messages.js';
import { groupBacklog } from '../src/office/backlogGroups.js';
import { setBoardState } from '../src/office/boardStore.js';
import { emptyExecutorStore, setExecutorStore } from '../src/office/executorStore.js';
import { setProjectSummaryStore } from '../src/office/projectSummaryStore.js';
import { workflowBacklog } from '../src/office/workflowBacklog.js';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
vi.mock('../src/transport/index.js', () => ({
  transport: {
    state: 'connected',
    onStateChange: () => () => {},
    send: vi.fn(),
  },
}));

afterEach(() => {
  setBoardState(null);
  setExecutorStore(emptyExecutorStore());
  setProjectSummaryStore({ phase: 'idle' });
});

// Keep TSX outside tsconfig.node's DOM-free dependency graph.
const componentPath = '../src/components/ProjectWorkflow.js';
const stages: WorkflowStage[] = [
  {
    id: 'qa',
    label: 'QA',
    state: 'workflow_active',
    taskKeys: ['second'],
    featureKeys: ['FEAT-001'],
    agents: ['real-session'],
  },
  {
    id: 'approval',
    label: 'Aprobación',
    state: 'workflow_human',
    taskKeys: [],
    featureKeys: ['FEAT-002'],
    agents: [],
  },
  {
    id: 'delivery',
    label: 'Entrega',
    state: 'workflow_done',
    taskKeys: ['done'],
    featureKeys: ['FEAT-003'],
    agents: [],
  },
];
const snapshot: ProjectSummarySnapshot = {
  type: 'projectSummarySnapshot',
  projectId: 'project',
  requestId: 'request',
  status: 'ok',
  reason: null,
  summary: {
    name: 'Proyecto',
    goals: [],
    features: [],
    milestones: [],
    deliveries: [],
    decisions: [],
    risks: [],
    blockers: [],
    nextSteps: [],
    notices: [],
    workflow: stages,
    cost: {
      source: 'none',
      executions: 0,
      costKnown: 0,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      tokenKnown: 0,
    },
  },
};
const items: BoardItem[] = [
  { id: 'first', title: 'Primera', phase: 'RUNNING', agentIds: [] },
  { id: 'second', title: 'Segunda', phase: 'QA', agentIds: [] },
  { id: 'done', title: 'Terminada', phase: 'DONE', agentIds: [] },
];

function clickNode(tree: ReactNode, label: string): boolean {
  for (const node of Children.toArray(tree)) {
    if (
      !isValidElement<{ children?: ReactNode; 'aria-label'?: string; onClick?: () => void }>(node)
    )
      continue;
    if (node.type === 'button' && node.props['aria-label'] === label) {
      node.props.onClick?.();
      return true;
    }
    if (clickNode(node.props.children, label)) return true;
  }
  return false;
}

describe('project workflow nodes and Backlog navigation', () => {
  it('renders server states with icons, counters and real sessions using escaped text', async () => {
    const { ProjectWorkflow } = await import(componentPath);
    const html = renderToStaticMarkup(
      createElement(ProjectWorkflow, { stages, onSelect: vi.fn() }),
    );
    for (const text of [
      'Flujo de trabajo',
      'Activo',
      'Esperando al humano',
      'Hecho',
      '<svg',
      '1 tarea',
      '1 funcionalidad',
      'Sesión real-session',
      'Sin sesiones activas',
    ])
      expect(html).toContain(text);
    expect(html.match(/<button/g)).toHaveLength(3);
    const unsafe = renderToStaticMarkup(
      createElement(ProjectWorkflow, {
        stages: [{ ...stages[0], label: '<script>QA</script>' }],
        onSelect: vi.fn(),
      }),
    );
    expect(unsafe).toContain('&lt;script&gt;QA&lt;/script&gt;');
    expect(unsafe).not.toContain('<script>');
  });

  it('clicks a node and reuses Backlog grouping over server-projected membership', async () => {
    const { ProjectWorkflow } = await import(componentPath);
    const selections: WorkflowStageId[] = [];
    const tree = ProjectWorkflow({
      stages,
      onSelect: (id: WorkflowStageId) => selections.push(id),
    });
    expect(clickNode(tree, 'Ver QA en Trabajo')).toBe(true);
    expect(selections).toEqual(['qa']);
    const filtered = workflowBacklog(items, snapshot, 'project', selections[0]);
    expect(filtered.items.map((item) => item.id)).toEqual(['second']);
    expect(groupBacklog(filtered.items).find((group) => group.id === 'inProgress')?.items).toEqual([
      items[1],
    ]);
    expect(workflowBacklog(items, snapshot, 'project', 'approval').items).toEqual([]);
    expect(workflowBacklog(items, snapshot, 'project', 'delivery').items).toEqual([items[2]]);
    expect(workflowBacklog(items, snapshot, 'project', null).items).toBe(items);
  });

  it('hides membership on Project switch, missing snapshot and denied reads', () => {
    expect(workflowBacklog(items, snapshot, 'other', 'qa').items).toEqual([]);
    expect(workflowBacklog(items, null, 'project', 'qa').items).toEqual([]);
    expect(
      workflowBacklog(items, { ...snapshot, status: 'denied', summary: null }, 'project', 'qa')
        .items,
    ).toEqual([]);
    expect(
      workflowBacklog(items, { ...snapshot, status: 'denied', summary: null }, 'project', 'qa')
        .message,
    ).toContain('Acceso denegado');
  });

  it('renders the existing Trabajo panel with only the selected stage and a clear action', async () => {
    setExecutorStore({
      ...emptyExecutorStore(),
      state: {
        type: 'executorState',
        projectId: 'project',
        executors: [],
        sequence: 1,
        canManage: false,
        revision: 'one',
        observedAt: 0,
        configurationStatus: 'ready',
      },
    });
    setProjectSummaryStore({ phase: 'settled', projectId: 'project', snapshot });
    setBoardState({
      type: 'boardState',
      projectId: 'project',
      project: 'Proyecto',
      items,
      recent: [],
      decisions: [],
      waiting: [],
      gate: [],
      generatedAt: 0,
      summary: { total: items.length, byPhase: { RUNNING: 1, QA: 1, DONE: 1 }, byEpic: {} },
      sources: { board: true, claims: false, progress: false, workStore: true },
      quota: {
        claude: {
          provider: 'claude',
          status: 'unknown',
          usedPercent: null,
          resetsAt: null,
          observedAt: null,
        },
        codex: {
          provider: 'codex',
          status: 'unknown',
          usedPercent: null,
          resetsAt: null,
          observedAt: null,
        },
      },
    });
    const panelPath = '../src/components/BacklogPanel.js';
    const { BacklogPanel } = await import(panelPath);
    const html = renderToStaticMarkup(
      createElement(BacklogPanel, {
        isOpen: true,
        hosted: true,
        onClose: vi.fn(),
        onFocusAgent: vi.fn(),
        officeState: { characters: new Map() },
        workflowStage: 'qa',
        onClearWorkflowStage: vi.fn(),
      }),
    );
    expect(html).toContain('Etapa · QA');
    expect(html).toContain('Ver todo el trabajo');
    expect(html).toContain('Segunda');
    expect(html).not.toContain('Primera');
    expect(html).not.toContain('Terminada');
    expect(html.match(/data-testid="backlog-card"/g)).toHaveLength(1);
  });
});
