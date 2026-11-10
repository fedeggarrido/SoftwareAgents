import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';

import { DOCK_ICON_SIZE_PX } from '../src/constants.js';
import type { BoardState } from '../src/office/boardStore.js';
import { setBoardState } from '../src/office/boardStore.js';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_: unknown, get: () => unknown) => get(),
}));
const runtime = vi.hoisted(() => ({ isBrowserRuntime: true }));
vi.mock('../src/runtime.js', () => runtime);
vi.mock('../src/transport/index.js', () => ({ transport: { send: vi.fn() } }));

// Keep TSX outside tsconfig.node's DOM-free dependency graph.
const toolbarPath = '../src/components/BottomToolbar.js';
const props = {
  isEditMode: false,
  isSettingsOpen: false,
  activePanel: null,
  onTogglePanel: vi.fn(),
  onNewIdea: vi.fn(),
  onToggleSettings: vi.fn(),
  onToggleEditMode: vi.fn(),
  onOpenClaude: vi.fn(),
  workspaceFolders: [],
};
const board: BoardState = {
  type: 'boardState',
  generatedAt: 0,
  project: 'Demo',
  summary: { total: 0, byPhase: {}, byEpic: {} },
  items: [],
  recent: [],
  decisions: [],
  waiting: [],
  gate: [],
  sources: { board: true, claims: false, progress: false },
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
};

afterEach(() => {
  setBoardState(null);
  runtime.isBrowserRuntime = true;
  vi.unstubAllGlobals();
});

it('groups primary, panel segments and secondary controls in keyboard order', async () => {
  const { BottomToolbar } = await import(toolbarPath);
  const html = renderToStaticMarkup(createElement(BottomToolbar, props));
  expect(html).toContain('role="group" aria-label="Paneles"');
  expect(html).toContain('role="group" aria-label="Oficina y ajustes"');
  expect([...html.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((match) => match[1])).toEqual([
    'Nueva idea',
    'Trabajo',
    'Decisiones',
    'Features',
    'Auditoría',
    'Editar oficina',
    'Ajustes',
  ]);
  expect(html.match(/class="dock-button dock-primary"/g)).toHaveLength(1);
  expect(html).toContain(`width="${DOCK_ICON_SIZE_PX}" height="${DOCK_ICON_SIZE_PX}"`);
  expect(html).toContain('shape-rendering="crispEdges"');
});

it('retains the VS Code launcher as a secondary icon without adding an accent action', async () => {
  const { BottomToolbar } = await import(toolbarPath);
  runtime.isBrowserRuntime = false;
  const html = renderToStaticMarkup(createElement(BottomToolbar, props));
  expect(html).toContain('aria-label="Abrir agente"');
  expect(html.match(/class="dock-button dock-primary"/g)).toHaveLength(1);
  const editing = renderToStaticMarkup(
    createElement(BottomToolbar, { ...props, isEditMode: true }),
  );
  expect(editing).not.toContain('aria-label="Abrir agente"');
});

it.each(['backlog', 'decisions', 'features', 'audit', 'meeting', null])(
  'derives the pressed segment from the shared window tab %s',
  async (activePanel) => {
    const { BottomToolbar } = await import(toolbarPath);
    const html = renderToStaticMarkup(createElement(BottomToolbar, { ...props, activePanel }));
    const pressed = [
      ...html.matchAll(/<button[^>]*aria-label="([^"]+)"[^>]*aria-pressed="true"/g),
    ].map((match) => match[1]);
    const labels: Record<string, string> = {
      backlog: 'Trabajo',
      decisions: 'Decisiones',
      features: 'Features',
      audit: 'Auditoría',
    };
    expect(pressed).toEqual(activePanel && labels[activePanel] ? [labels[activePanel]] : []);
  },
);

it('counts only open decisions and exposes the icon and number as a description', async () => {
  const { BottomToolbar } = await import(toolbarPath);
  const empty = renderToStaticMarkup(createElement(BottomToolbar, props));
  expect(empty).not.toContain('class="dock-badge"');
  setBoardState({
    ...board,
    decisions: [
      { id: 'd1', status: 'open', question: '¿Continuar?', options: [] },
      { id: 'd2', status: 'answered', question: '¿Listo?', options: [] },
    ],
  });
  const html = renderToStaticMarkup(createElement(BottomToolbar, props));
  expect(html).toContain('aria-describedby="dock-decisions-pending"');
  expect(html).toContain('aria-label="1 decisión pendiente"');
  expect(html).toMatch(/class="dock-badge"[^>]*>.*<svg.*<\/svg>1<\/span>/);
});

it('keeps the same controls and labels when PR observations arrive', async () => {
  const { BottomToolbar } = await import(toolbarPath);
  const before = renderToStaticMarkup(createElement(BottomToolbar, props));
  setBoardState({
    ...board,
    items: [{ id: 'SA-153', title: 'Dock', phase: 'REVIEW', agentIds: [], prRef: 'demo/repo#1' }],
  });
  const after = renderToStaticMarkup(createElement(BottomToolbar, props));
  expect(after.match(/<button\b/g)).toHaveLength(before.match(/<button\b/g)!.length);
  expect(after).toContain('Estado de PR:');
  expect(after).not.toContain('dock-pr-status');
});

it('collapses editing mode to exit and settings at desktop and mobile widths', async () => {
  const { BottomToolbar } = await import(toolbarPath);
  for (const innerWidth of [1440, 390]) {
    vi.stubGlobal('window', { innerWidth });
    const html = renderToStaticMarkup(createElement(BottomToolbar, { ...props, isEditMode: true }));
    expect(
      [...html.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((match) => match[1]),
    ).toEqual(['Salir de edición', 'Ajustes']);
  }
});

it.each([320, 390, 767, 768])('uses four mobile slots below 768px at %spx', async (innerWidth) => {
  const { BottomToolbar } = await import(toolbarPath);
  vi.stubGlobal('window', { innerWidth });
  const html = renderToStaticMarkup(createElement(BottomToolbar, props));
  expect(html.match(/<button\b/g)).toHaveLength(innerWidth < 768 ? 4 : 7);
  if (innerWidth < 768) {
    expect(html).toContain('aria-controls="dock-more-sheet"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('<span>Idea</span>');
    expect(html).not.toContain('aria-label="Editar oficina"');
  }
});
