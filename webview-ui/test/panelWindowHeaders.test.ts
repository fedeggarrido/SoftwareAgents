import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { PANEL_TABS } from '../src/constants.js';
import { setBoardState } from '../src/office/boardStore.js';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_: unknown, get: () => unknown) => get(),
}));

vi.mock('../src/transport/index.js', () => ({
  transport: {
    state: 'connected',
    onStateChange: () => () => {},
    send: vi.fn(),
  },
}));

// Dynamic paths keep TSX outside the DOM-free test project's dependency graph.
const windowPath = '../src/components/PanelWindow.js';
const panelPaths = {
  backlog: ['../src/components/BacklogPanel.js', 'BacklogPanel'],
  decisions: ['../src/components/DecisionsPanel.js', 'DecisionsPanel'],
  audit: ['../src/components/AuditPanel.js', 'AuditPanel'],
  features: ['../src/components/FeaturesPanel.js', 'FeaturesPanel'],
  meeting: ['../src/components/MeetingPanel.js', 'MeetingPanel'],
};

it.each(PANEL_TABS)(
  '$label uses the window title and close, with a tab-labelled panel',
  async ({ id, label }) => {
    setBoardState({
      type: 'boardState',
      generatedAt: 0,
      summary: { total: 0, byPhase: {}, byEpic: {} },
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
      project: 'Demo',
      items: [],
      recent: [],
      decisions: [],
      waiting: [],
      gate: [],
      sources: { board: true, claims: false, progress: false },
      meeting: {
        id: 'm1',
        format: 'delphi',
        topic: 'Next step',
        question: 'What next?',
        participants: [],
        status: 'running',
        round: 'borrador',
        lines: [],
      },
    });
    const { PanelWindow } = await import(windowPath);
    const [panelPath, exportName] = panelPaths[id];
    const component = (await import(panelPath))[exportName];
    const child = createElement(component, {
      hosted: true,
      isOpen: true,
      onClose: vi.fn(),
      onFocusAgent: vi.fn(),
      officeState: { characters: new Map() },
    });
    const content = renderToStaticMarkup(child);
    expect(content).not.toMatch(/<h2\b/);
    expect(content).not.toMatch(/<button\b[^>]*(?:aria-label|title)="Cerrar/);
    expect(content).not.toContain('✕');
    expect(content).not.toContain('Decisiones del propietario');
    expect(content).not.toContain('Sala de reuniones');
    const html = renderToStaticMarkup(
      createElement(PanelWindow, {
        isOpen: true,
        tab: id,
        rect: null,
        mobile: true,
        onSelect: vi.fn(),
        onRectChange: vi.fn(),
        onReset: vi.fn(),
        onClose: vi.fn(),
        children: child,
      }),
    );
    expect(html).toContain(`role="tabpanel" aria-labelledby="office-tab-${id}"`);
    expect(html).toContain(`id="office-tab-${id}" role="tab" aria-label="${label}"`);
    expect(html.match(/aria-label="Cerrar ventana"/g)).toHaveLength(1);
    if (id === 'backlog') expect(content).toContain('Te necesitan');
    if (id === 'features') expect(content).toContain('Actualizar');
    if (id === 'meeting') {
      expect(content).toContain('Ocultar detalles');
      expect(content).toContain('en curso');
      expect(content).toContain('aria-expanded="true"');
    }
    // The office mode badge already says «Solo lectura»; panels do not repeat it (SA-152).
    expect(content).not.toContain('solo lectura');
  },
);
