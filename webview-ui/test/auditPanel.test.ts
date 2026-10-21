import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditLogSnapshot } from '../../core/src/messages.js';
import { emptyAuditStore, setAuditStore } from '../src/office/auditStore.js';

vi.mock('../src/transport/index.js', () => ({ transport: { send: vi.fn() } }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useEffect: () => {},
}));
// Dynamic module path keeps TSX out of the node-only test TypeScript project.
const panelPath = '../src/components/AuditPanel.js';
const render = async () => {
  const { AuditPanel } = await import(panelPath);
  return renderToStaticMarkup(createElement(AuditPanel, { isOpen: true, onClose: () => {} }));
};
const snapshot = (over: Partial<AuditLogSnapshot> = {}): AuditLogSnapshot => ({
  type: 'auditLog', projectId: 'P', requestId: 'r', status: 'ok', entries: [],
  totalValid: 520, truncated: true, corruptLines: Array.from({ length: 51 }, (_, i) => i + 1),
  excludedCount: 2, ...over,
});
beforeEach(() => setAuditStore({ ...emptyAuditStore(), projectId: 'P', snapshot: snapshot() }));
describe('FEAT-001-T04 audit panel acceptance', () => {
  it('AC-009/010/017: preserves whole-file notices without showing an empty log', async () => {
    const html = await render();
    expect(html).toContain('mostrando las 500 más recientes de 520');
    expect(html).toContain('51 líneas corruptas');
    expect(html).toContain('49, 50…');
    expect(html).toContain('2 entradas excluidas');
    expect(html).not.toContain('No hay entradas de auditoría');
  });
  it.each([
    ['empty', 'No hay entradas de auditoría'],
    ['read_error', 'Error de lectura'],
    ['denied', 'Acceso denegado'],
  ] as const)('AC-007/008: distinguishes %s', async (status, text) => {
    setAuditStore({ ...emptyAuditStore(), projectId: 'P', snapshot: snapshot({ status, truncated: false, corruptLines: [], excludedCount: 0 }) });
    expect(await render()).toContain(text);
  });
  it('AC-001/015/019/020: renders fields as text with closed details and invalid-date marker', async () => {
    setAuditStore({ ...emptyAuditStore(), projectId: 'P', snapshot: snapshot({ entries: [{
      line: 7, occurredAt: 'invalid', actorType: 'human', actorId: null, action: '<script>',
      resourceType: 'task', resourceId: null, policyDecision: null, taskKey: null,
      executionId: null, riskLevel: 'low',
      outcome: { status: 'allowed', reason: 'because', detail: 'details', tier: null, executor: null, model: null, code: null },
    }] }) });
    const html = await render();
    for (const text of ['Fecha no válida', 'human', '&lt;script&gt;', 'because', 'sin valor', 'details']) expect(html).toContain(text);
    expect(html).toContain('<details>');
    expect(html).not.toContain('<details open');
    expect(html).not.toMatch(/inputHash|Exportar|Retención|Crear entrada/);
    setAuditStore({ ...emptyAuditStore(), projectId: 'P', actionFilter: 'absent', snapshot: snapshot({ entries: [{
      line: 1, occurredAt: '2026-10-16T10:00:05Z', actorType: 'human', actorId: null,
      action: 'read', resourceType: 'task', resourceId: null, policyDecision: null,
      taskKey: null, executionId: null, riskLevel: 'low',
      outcome: { status: 'ok', reason: null, detail: null, tier: null, executor: null, model: null, code: null },
    }] }) });
    const noMatches = await render();
    expect(noMatches).toContain('Ninguna entrada cumple los filtros');
    expect(noMatches).toContain('Quitar filtros');
    expect(noMatches).toContain('mostrando las 500 más recientes de 520');
    setAuditStore({ ...emptyAuditStore(), projectId: 'P', snapshot: { ...snapshot(), entries: [{
      line: 1, occurredAt: '2026-10-16T10:00:05Z', actorType: 'human', actorId: null,
      action: 'read', resourceType: 'task', resourceId: null, policyDecision: null,
      taskKey: null, executionId: null, riskLevel: 'low',
      outcome: { status: 'ok', reason: null, detail: null, tier: null, executor: null, model: null, code: null },
    }] } });
    expect(await render()).toContain('title="2026-10-16 10:00:05 UTC"');
  });
});
