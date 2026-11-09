import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditLogSnapshot, AuditViewEntry } from '../../core/src/messages.js';
import {
  applyAuditLog,
  emptyAuditStore,
  getAuditStore,
  setAuditStore,
} from '../src/office/auditStore.js';
import { emptyExecutorStore, setExecutorStore } from '../src/office/executorStore.js';

const lifecycle = vi.hoisted(() => ({
  effects: [] as Array<() => void>,
  state: 'connected',
  send: vi.fn(),
}));

vi.mock('../src/transport/index.js', () => ({
  transport: {
    send: lifecycle.send,
    get state() {
      return lifecycle.state;
    },
    onStateChange: () => () => {},
  },
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useEffect: (effect: () => void) => {
    lifecycle.effects.push(effect);
  },
}));
// Dynamic module path keeps TSX out of the node-only test TypeScript project.
const panelPath = '../src/components/AuditPanel.js';
const render = async (isOpen = true) => {
  const { AuditPanel } = await import(panelPath);
  return renderToStaticMarkup(createElement(AuditPanel, { isOpen, onClose: () => {} }));
};
const snapshot = (over: Partial<AuditLogSnapshot> = {}): AuditLogSnapshot => ({
  type: 'auditLog',
  projectId: 'P',
  requestId: 'r',
  status: 'ok',
  entries: [],
  totalValid: 520,
  truncated: true,
  corruptLines: Array.from({ length: 51 }, (_, i) => i + 1),
  excludedCount: 2,
  ...over,
});
const entry = (over: Partial<AuditViewEntry> = {}): AuditViewEntry => ({
  line: 1,
  occurredAt: '2026-10-16T10:00:05Z',
  actorType: 'human',
  actorId: null,
  action: 'read',
  resourceType: 'task',
  resourceId: null,
  policyDecision: null,
  taskKey: null,
  executionId: null,
  riskLevel: 'low',
  outcome: {
    status: 'ok',
    reason: 'because',
    detail: 'details',
    tier: null,
    executor: null,
    model: null,
    code: null,
  },
  ...over,
});

beforeEach(() => {
  lifecycle.effects = [];
  lifecycle.state = 'connected';
  lifecycle.send.mockClear();
  setExecutorStore({
    ...emptyExecutorStore(),
    state: { projectId: 'P' } as NonNullable<ReturnType<typeof emptyExecutorStore>['state']>,
  });
  setAuditStore({ ...emptyAuditStore(), projectId: 'P', snapshot: snapshot() });
});

describe('FEAT-001-T04 audit panel acceptance', () => {
  it('disables clearing default filters and enables it for an active filter', async () => {
    expect(await render()).toMatch(/<button[^>]*disabled=""[^>]*>Quitar filtros<\/button>/);
    setAuditStore({ ...getAuditStore(), actionFilter: 'read' });
    expect(await render()).not.toMatch(/<button[^>]*disabled=""[^>]*>Quitar filtros<\/button>/);
  });
  it('distinguishes read errors with a shared retry alert and preserves filters on retry', async () => {
    setExecutorStore({
      ...emptyExecutorStore(),
      state: { projectId: 'P' } as NonNullable<ReturnType<typeof emptyExecutorStore>['state']>,
    });
    setAuditStore({
      ...getAuditStore(),
      actionFilter: 'read',
      snapshot: snapshot({ status: 'read_error' }),
    });
    const html = await render();
    expect(html).toContain('role="alert"');
    expect(html).toContain('panel-error');
    expect(html).toContain('Reintentar');
    const { AuditPanel } = await import(panelPath);
    function retry(node: unknown): (() => void) | undefined {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.map(retry).find(Boolean);
      const props = (node as { props?: { onRetry?: () => void; children?: unknown } }).props;
      return props?.onRetry ?? retry(props?.children);
    }
    retry(AuditPanel({ isOpen: true, onClose: () => {} }))!();
    expect(lifecycle.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'requestAuditLog', projectId: 'P' }),
    );
    expect(getAuditStore().actionFilter).toBe('read');
    expect(await render()).toContain('Cargando');
    setAuditStore({ ...getAuditStore(), loading: false, snapshot: snapshot({ status: 'empty' }) });
    expect(await render()).not.toContain('role="alert"');
  });
  it('AC-013/015: requests on open and reconnect, isolates Projects and rejects stale responses', async () => {
    const project = (projectId: string) =>
      setExecutorStore({
        ...emptyExecutorStore(),
        state: { projectId } as NonNullable<ReturnType<typeof emptyExecutorStore>['state']>,
      });
    // Execute the actual panel effect after rendering, without requiring a DOM.
    const flush = async (isOpen = true) => {
      lifecycle.effects = [];
      await render(isOpen);
      for (const effect of lifecycle.effects) effect();
    };
    setAuditStore(emptyAuditStore());
    project('P');
    await flush();
    expect(lifecycle.send).toHaveBeenCalledTimes(1);
    const first = getAuditStore().requestId!;
    expect(lifecycle.send).toHaveBeenLastCalledWith({
      type: 'requestAuditLog',
      projectId: 'P',
      requestId: first,
    });
    setAuditStore(applyAuditLog(getAuditStore(), snapshot({ requestId: first })));
    lifecycle.state = 'reconnecting';
    setAuditStore(emptyAuditStore());
    await flush();
    expect(lifecycle.send).toHaveBeenCalledTimes(1);
    lifecycle.state = 'connected';
    await flush();
    expect(lifecycle.send).toHaveBeenCalledTimes(2);
    expect(getAuditStore().requestId).not.toBe(first);
    const pending = getAuditStore();
    setAuditStore(applyAuditLog(pending, snapshot({ requestId: first })));
    expect(getAuditStore()).toBe(pending);
    setAuditStore({
      ...applyAuditLog(
        pending,
        snapshot({
          requestId: pending.requestId!,
          entries: [entry({ action: 'P-only' })],
        }),
      ),
      actionFilter: 'P-only',
      outcomeFilter: 'ok',
    });
    expect(await render()).toContain('P-only');
    project('Q');
    await flush();
    expect(getAuditStore()).toMatchObject({
      projectId: 'Q',
      snapshot: null,
      actionFilter: null,
      outcomeFilter: null,
    });
    expect(lifecycle.send).toHaveBeenCalledTimes(3);
    expect(await render()).not.toContain('P-only');
    setAuditStore(applyAuditLog(getAuditStore(), snapshot({ requestId: first })));
    expect(getAuditStore().snapshot).toBeNull();
    await flush(false);
    expect(getAuditStore()).toEqual(emptyAuditStore());
    await flush();
    expect(lifecycle.send).toHaveBeenCalledTimes(4);
  });

  it('AC-009/010/017: preserves whole-file notices without showing an empty log', async () => {
    const html = await render();
    expect(html).toContain('mostrando las 500 más recientes de 520');
    expect(html).toContain('51 líneas corruptas');
    expect(html).toContain('49, 50…');
    expect(html).toContain('2 entradas excluidas');
    expect(html).not.toContain('Aún no hay nada registrado.');
  });

  it.each([
    ['empty', 'Aún no hay nada registrado.'],
    ['read_error', 'No se pudo consultar el registro de auditoría.'],
    ['denied', 'Acceso denegado'],
  ] as const)('AC-007/008: distinguishes %s', async (status, text) => {
    setAuditStore({
      ...emptyAuditStore(),
      projectId: 'P',
      snapshot: snapshot({ status, truncated: false, corruptLines: [], excludedCount: 0 }),
    });
    expect(await render()).toContain(text);
  });

  it('AC-001/015/019/020: renders text with closed details and invalid-date marker', async () => {
    setAuditStore({
      ...emptyAuditStore(),
      projectId: 'P',
      snapshot: snapshot({ entries: [entry({ occurredAt: 'invalid', action: '<script>' })] }),
    });
    const html = await render();
    for (const text of [
      'fecha no válida',
      'La persona operadora',
      '&lt;script&gt;',
      'because',
      'sin valor',
      'details',
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('<details>');
    expect(html).not.toContain('<details open');
    expect(html).not.toMatch(/inputHash|Exportar|Retención|Crear entrada/);
    setAuditStore({
      ...emptyAuditStore(),
      projectId: 'P',
      snapshot: snapshot({ entries: [entry()] }),
    });
    expect(await render()).toContain('title="2026-10-16 10:00:05 UTC"');
  });

  it('AC-006: distinguishes no matches and preserves notices', async () => {
    setAuditStore({
      ...emptyAuditStore(),
      projectId: 'P',
      actionFilter: 'absent',
      snapshot: snapshot({ entries: [entry()] }),
    });
    const html = await render();
    expect(html).toContain('Ninguna entrada cumple los filtros');
    expect(html).toContain('Quitar filtros');
    expect(html).toContain('mostrando las 500 más recientes de 520');
  });
});

it('explains the log and why no project is linked, using actionable Spanish copy', async () => {
  setExecutorStore(emptyExecutorStore());
  setAuditStore(emptyAuditStore());
  const html = await render();
  expect(html).toContain('Registro de acciones de personas y agentes');
  expect(html).toContain('No se puede editar');
  expect(html).toContain('Esta oficina no tiene un proyecto preparado vinculado');
  expect(html).toContain('Abre la oficina desde la carpeta de un proyecto preparado');
  expect(html).not.toContain('Project');
});
it('renders actor, action, short task and relative time without UUIDs', async () => {
  setAuditStore({
    ...getAuditStore(),
    snapshot: snapshot({
      entries: [
        entry({
          actorType: 'agent',
          actorId: '95dab749-8868-486c-b372-8805d140b7ca',
          action: 'launch_execution',
          taskKey: 'SA-119',
          executionId: '95dab749-8868-486c-b372-8805d140b7ca',
          occurredAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ],
    }),
  });
  const html = await render();
  expect(html).toContain('El agente solicitó una ejecución en SA-119, hace 1 min');
  expect(html).not.toContain('95dab749');
});
