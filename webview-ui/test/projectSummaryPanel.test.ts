import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProjectSummary, ProjectSummarySnapshot } from '../../core/src/messages.js';
import { emptyExecutorStore, setExecutorStore } from '../src/office/executorStore.js';
import {
  applyProjectSummary,
  getProjectSummaryStore,
  requestProjectSummary,
  setProjectSummaryStore,
  type SummaryStore,
} from '../src/office/projectSummaryStore.js';

const lifecycle = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  send: vi.fn(),
  connection: 'connected',
}));
vi.mock('../src/transport/index.js', () => ({
  transport: {
    send: lifecycle.send,
    get state() {
      return lifecycle.connection;
    },
    onStateChange: () => () => {},
    onMessage: () => () => {},
  },
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  useEffect: (effect: () => void | (() => void)) => lifecycle.effects.push(effect),
}));

// Keep TSX outside tsconfig.node's DOM-free dependency graph, like the existing panels.
const panelPath = '../src/components/ProjectSummaryPanel.js';
const summary = (): ProjectSummary => ({
  name: 'Pedidos',
  goals: [],
  features: [],
  milestones: [],
  deliveries: [],
  decisions: [],
  risks: [],
  blockers: [],
  nextSteps: [],
  notices: [],
  cost: {
    source: 'none',
    executions: 0,
    costKnown: 0,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    tokenKnown: 0,
  },
});
const snapshot = (overrides: Partial<ProjectSummarySnapshot> = {}): ProjectSummarySnapshot => ({
  type: 'projectSummarySnapshot',
  projectId: 'project',
  requestId: 'request',
  status: 'ok',
  reason: null,
  summary: summary(),
  ...overrides,
});
const loading = (): SummaryStore => ({
  phase: 'loading',
  projectId: 'project',
  requestId: 'request',
});

afterEach(() => {
  setProjectSummaryStore({ phase: 'idle' });
  setExecutorStore(emptyExecutorStore());
  lifecycle.connection = 'connected';
  lifecycle.effects = [];
  lifecycle.send.mockClear();
});

describe('summary read lifecycle', () => {
  it('rejects other Projects, old requests and responses arriving after timeout', () => {
    const state = loading();
    expect(applyProjectSummary(state, snapshot({ projectId: 'other' }))).toBe(state);
    expect(applyProjectSummary(state, snapshot({ requestId: 'old' }))).toBe(state);
    const timeout = applyProjectSummary(
      state,
      snapshot({ status: 'read_error', reason: 'unavailable', summary: null }),
    );
    expect(applyProjectSummary(timeout, snapshot())).toBe(timeout);
    expect(applyProjectSummary({ phase: 'idle' }, snapshot())).toEqual({ phase: 'idle' });
  });

  it('clears displayed data before sending every read, including refresh', () => {
    setProjectSummaryStore(applyProjectSummary(loading(), snapshot()));
    const send = vi.fn((message: { type: string }) => {
      expect(message.type).toBe('requestProjectSummary');
      expect(getProjectSummaryStore()).toMatchObject({ phase: 'loading', projectId: 'other' });
    });
    requestProjectSummary({ send }, 'other');
    const first = getProjectSummaryStore();
    requestProjectSummary({ send }, 'other');
    expect(getProjectSummaryStore()).not.toEqual(first);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(([message]) => message.type === 'requestProjectSummary')).toBe(
      true,
    );
  });
});

describe('project summary panel', () => {
  it('explains a new project and where its data will appear without fake numbers or write actions', async () => {
    const { ProjectSummaryPanel } = await import(panelPath);
    const html = renderToStaticMarkup(
      createElement(ProjectSummaryPanel, {
        isOpen: true,
        hosted: true,
        onClose: vi.fn(),
        onNavigate: vi.fn(),
      }),
    );
    expect(html).toContain('Crea una Nueva idea');
    expect(html).toContain('su objetivo, progreso, entregas y próximos pasos');
    expect(html).not.toMatch(/USD|<input|<textarea|Preparar proyecto/);
  });

  it('renders every section in plain text with Spanish status chips and recorded coverage', async () => {
    const { ProjectSummaryContent } = await import(panelPath);
    const data = summary();
    data.goals = [{ key: 'goal', text: '<script>Construir pedidos</script>', at: null }];
    data.features = [
      {
        key: 'FEAT-001',
        title: 'Recibos',
        state: 'summary_in_progress',
        done: 2,
        inProgress: 1,
        pending: 3,
        cancelled: 0,
        total: 6,
      },
    ];
    data.decisions = [{ key: 'decision', text: '¿Enviar recibos por correo?', at: null }];
    data.risks = [{ key: 'risk', text: 'Pérdida de conexión', at: null }];
    data.nextSteps = [{ key: 'next', text: 'Preparada para empezar · Crear recibos', at: null }];
    data.cost = {
      source: 'ledger',
      executions: 3,
      costKnown: 2,
      costUsd: 0.75,
      inputTokens: 100,
      outputTokens: 25,
      tokenKnown: 2,
    };
    const html = renderToStaticMarkup(createElement(ProjectSummaryContent, { summary: data }));
    for (const text of [
      'Qué estamos construyendo',
      'Decisiones que te esperan',
      'Hitos alcanzados',
      'Últimas entregas',
      'Riesgos registrados',
      'Bloqueos',
      'Coste y consumo',
      'Próximos pasos',
      '2 hechas · 1 en curso · 3 pendientes',
      '0.75 USD (parcial)',
      '2 de 3 ejecuciones registradas',
      'En curso',
      'status-chip',
      '<svg',
    ])
      expect(html).toContain(text);
    expect(html).toContain('&lt;script&gt;Construir pedidos&lt;/script&gt;');
    expect(html).not.toMatch(/<script>|<button|<input|<select|<textarea/);
  });

  it('distinguishes missing cost, unknown cost and a recorded zero', async () => {
    const { ProjectSummaryContent } = await import(panelPath);
    const data = summary();
    expect(renderToStaticMarkup(createElement(ProjectSummaryContent, { summary: data }))).toContain(
      'Sin datos de coste o consumo registrados.',
    );
    data.cost.executions = 1;
    data.cost.source = 'ledger';
    const unknown = renderToStaticMarkup(createElement(ProjectSummaryContent, { summary: data }));
    expect(unknown).toContain('Coste registrado · sin datos');
    expect(unknown).not.toContain('0.00 USD');
    data.cost.costKnown = 1;
    data.cost.costUsd = 0;
    expect(renderToStaticMarkup(createElement(ProjectSummaryContent, { summary: data }))).toContain(
      '0.00 USD',
    );
    data.cost = {
      ...data.cost,
      source: 'retained_telemetry',
      costKnown: 0,
      costUsd: null,
      tokenKnown: null,
    };
    const retained = renderToStaticMarkup(createElement(ProjectSummaryContent, { summary: data }));
    expect(retained).toContain('historial de telemetría conservado');
    expect(retained).not.toContain('0.00 USD');
    expect(retained).not.toContain('estimación API registrada');
  });

  it('hides previous project data before effects on switch or disconnect', async () => {
    const { ProjectSummaryPanel } = await import(panelPath);
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
    const data = summary();
    data.name = 'PRIVATE_OLD_PROJECT';
    setProjectSummaryStore(applyProjectSummary(loading(), snapshot({ summary: data })));
    const render = () =>
      renderToStaticMarkup(
        createElement(ProjectSummaryPanel, {
          isOpen: true,
          hosted: true,
          onClose: vi.fn(),
          onNavigate: vi.fn(),
        }),
      );
    expect(render()).toContain('PRIVATE_OLD_PROJECT');
    setExecutorStore({
      ...emptyExecutorStore(),
      state: {
        type: 'executorState',
        projectId: 'other',
        executors: [],
        sequence: 2,
        canManage: false,
        revision: 'two',
        observedAt: 0,
        configurationStatus: 'ready',
      },
    });
    expect(render()).not.toContain('PRIVATE_OLD_PROJECT');
    lifecycle.connection = 'reconnecting';
    expect(render()).toContain('recuperar la conexión');
    expect(render()).not.toContain('PRIVATE_OLD_PROJECT');
  });
});
