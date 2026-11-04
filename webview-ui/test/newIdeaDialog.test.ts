import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdeasSnapshot, SubmitIdeaResult } from '../../core/src/messages.js';
import { emptyIdeasStore, setIdeasStore } from '../src/office/ideasStore.js';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_: unknown, get: () => unknown) => get(),
  useEffect: () => {},
}));
const wire = vi.hoisted(() => ({ state: 'connected' }));
vi.mock('../src/transport/index.js', () => ({
  transport: {
    get state() {
      return wire.state;
    },
    onStateChange: () => () => {},
    send: vi.fn(),
  },
}));
const dialogPath = '../src/components/NewIdeaDialog.js';
const listPath = '../src/components/IdeasList.js';
const snapshot: IdeasSnapshot = {
  type: 'ideasSnapshot',
  requestId: 'r',
  projectId: 'P',
  canSubmit: true,
  errorCode: null,
  ideas: [],
};
const result: SubmitIdeaResult = {
  type: 'submitIdeaResult',
  requestId: 's',
  projectId: 'P',
  status: 'saved',
  errorCode: null,
  idea: {
    key: 'FEAT-001',
    command:
      'pixel-agents feature run FEAT-001 --request .softwareagents/ideas/P/FEAT-001.md --confirm',
  },
};
async function render() {
  const { NewIdeaDialog } = await import(dialogPath);
  return renderToStaticMarkup(createElement(NewIdeaDialog, { onClose: vi.fn() }));
}
beforeEach(() => {
  wire.state = 'connected';
  setIdeasStore(emptyIdeasStore());
});

describe('SA-109 dialog and draft presentation', () => {
  it('renders an accessible Spanish pixel dialog with a free text box', async () => {
    setIdeasStore({ ...emptyIdeasStore(), snapshot });
    const html = await render();
    for (const text of [
      'Nueva idea',
      'role="dialog"',
      'aria-modal="true"',
      '<textarea',
      'Tu idea',
      'Guardar idea',
      'shadow-pixel',
      'no inicia ningún trabajo',
    ])
      expect(html).toContain(text);
  });
  it.each([
    ['denied', 'Solo lectura'],
    ['missing_manifest', '.softwareagents/project.yaml'],
    ['invalid_manifest', 'no es válido'],
    ['no_project', 'no hay un Project'],
    ['unsupported_adapter', 'VS Code'],
  ] as const)('explains %s instead of silently failing', async (errorCode, text) => {
    setIdeasStore({ ...emptyIdeasStore(), snapshot: { ...snapshot, canSubmit: false, errorCode } });
    const html = await render();
    expect(html).toContain(text);
    expect(html).toMatch(/<textarea[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Guardar idea/);
  });
  it('shows loading, saving, offline and uncertain states', async () => {
    expect(await render()).toContain('Comprobando');
    setIdeasStore({ ...emptyIdeasStore(), snapshot, pending: { requestId: 's', projectId: 'P' } });
    expect(await render()).toContain('Guardando…');
    wire.state = 'reconnecting';
    expect(await render()).toContain('Sin conexión');
    setIdeasStore({ ...emptyIdeasStore(), uncertain: true });
    expect(await render()).toContain('Consulta las ideas pendientes');
  });
  it('confirms only the assigned id and exact command, with audit warning when needed', async () => {
    setIdeasStore({
      ...emptyIdeasStore(),
      snapshot,
      result: { ...result, errorCode: 'audit_failed' },
    });
    const html = await render();
    expect(html).toContain('Idea guardada: <strong>FEAT-001</strong>');
    expect(html).toContain(result.idea!.command);
    expect(html).toContain('falta confirmar su auditoría');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('Guardar idea');
  });
  it('lists drafts separately from FeatureSpecs, without feature progress or execution controls', async () => {
    const { IdeasList } = await import(listPath);
    const html = renderToStaticMarkup(createElement(IdeasList, { ideas: [result.idea] }));
    for (const text of [
      'Ideas pendientes · sin FeatureSpec',
      'Idea · pendiente',
      'data-state="idea_pending"',
      result.idea!.command,
    ])
      expect(html).toContain(text);
    expect(html).not.toMatch(/progressbar|feature-cost|<button|<textarea/);
  });
});
