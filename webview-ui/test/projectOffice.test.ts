import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { BoardState } from '../../core/src/messages.js';
import { BacklogPanel } from '../src/components/BacklogPanel.js';
import { CompanyHud } from '../src/components/CompanyHud.js';
import type { OfficeState } from '../src/office/engine/officeState.js';

const state = vi.hoisted(() => ({ board: null as BoardState | null }));
vi.mock('../src/office/boardStore.js', () => ({
  useBoard: () => state.board,
  useCompanyNotice: () => null,
}));
vi.mock('../src/transport/index.js', () => ({ transport: { send: vi.fn() } }));
const officeState = { characters: new Map() } as OfficeState;
const noop = () => {};
function board(mode: 'project' | 'invalid' | 'legacy'): BoardState {
  const quota = (provider: 'claude' | 'codex') => ({
    provider,
    status: 'unknown' as const,
    usedPercent: null,
    resetsAt: null,
    observedAt: null,
  });
  return {
    type: 'boardState',
    mode,
    project: 'SoftwareAgents',
    projectId: 'softwareagents',
    items: [],
    recent: [],
    sources: { board: false, claims: false, progress: false },
    quota: { claude: quota('claude'), codex: quota('codex') },
    gate: [],
    summary: { total: 0, byPhase: {}, byEpic: {} },
    waiting: [],
    decisions: [],
    generatedAt: 1,
  };
}
describe('office without a board', () => {
  it('shows both providers and unknown capacity without legacy controls', () => {
    state.board = board('project');
    const html = renderToStaticMarkup(
      createElement(CompanyHud, { officeState, onOpenBacklog: noop, onOpenDecisions: noop }),
    );
    expect(html).toContain('Capacidad observada');
    expect(html).toContain('Claude');
    expect(html).toContain('Codex');
    expect(html).not.toContain('progressbar');
    expect(html).not.toContain('Piloto');
  });
  it.each(['project', 'legacy', 'invalid'] as const)('explains %s mode', (mode) => {
    state.board = board(mode);
    const html = renderToStaticMarkup(
      createElement(BacklogPanel, { officeState, isOpen: true, onClose: noop, onFocusAgent: noop }),
    );
    expect(html).toContain(
      mode === 'project'
        ? 'softwareagents'
        : mode === 'legacy'
          ? 'docs/backlog/board.json'
          : 'inválida',
    );
    expect(html).not.toContain('sin ronda activa');
  });
  it('links the configured ClickUp folder', () => {
    state.board = { ...board('project'), clickupFolderUrl: 'https://app.clickup.com/123/v/f/456' };
    const html = renderToStaticMarkup(
      createElement(BacklogPanel, { officeState, isOpen: true, onClose: noop, onFocusAgent: noop }),
    );
    expect(html).toContain('href="https://app.clickup.com/123/v/f/456"');
    expect(html).toContain('noopener noreferrer');
    expect(html).toContain('SA-053');
  });
});
