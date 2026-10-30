import { describe, expect, it } from 'vitest';

import type { BoardState } from '../../core/src/messages.js';
import { backlogView } from '../src/office/backlogView.js';
import { capacityHudView, capacityView } from '../src/office/capacityView.js';
import { decisionsHudView } from '../src/office/decisionsHudView.js';

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
  it('reports an unreadable WorkStore without suggesting legacy or ClickUp configuration', () => {
    const state = board('project');
    state.sources.workStore = true;
    expect(backlogView(state)).toMatchObject({
      message: expect.stringContaining('WorkStore no disponible'),
      configurationHint: null,
    });
    state.sources.board = true;
    expect(backlogView(state).message).toBeNull();
    expect(capacityHudView(state).minimal).toBe(false);
  });
  it.each([false, true])(
    'shows decisions independently of the legacy board source (board=%s)',
    (hasBoard) => {
      const state = board('project');
      state.sources.board = hasBoard;
      state.decisions = [
        { id: 'open', status: 'open', question: 'Review protected change?', options: ['review'] },
        { id: 'answered', status: 'answered', question: 'Previous?', options: [] },
        { id: 'expired', status: 'expired', question: 'Expired gate?', options: [] },
      ];
      expect(capacityHudView(state).minimal).toBe(!hasBoard);
      expect(decisionsHudView(state)).toEqual({ visible: true, open: 1, label: 'Decisiones (1)' });
      state.decisions[0].status = 'answered';
      expect(decisionsHudView(state)).toEqual({ visible: true, open: 0, label: 'Decisiones (0)' });
      state.decisions = [];
      expect(decisionsHudView(state).visible).toBe(false);
      expect(decisionsHudView({}).visible).toBe(false);
    },
  );
  it('selects the minimal HUD with unknown provider capacity', () => {
    const state = board('project');
    expect(capacityHudView(state)).toEqual({ minimal: true, title: 'Capacidad observada' });
    for (const provider of ['claude', 'codex'] as const) {
      expect(state.quota![provider].provider).toBe(provider);
      expect(capacityView(state.quota![provider], 0)).toMatchObject({
        status: 'Desconocida',
        detail: 'Aún no hay una lectura de cuota',
        windows: [],
      });
    }
    expect(capacityHudView({ ...state, sources: { ...state.sources, board: true } }).minimal).toBe(
      false,
    );
  });
  it.each(['project', 'legacy', 'invalid'] as const)('explains %s mode', (mode) => {
    const view = backlogView(board(mode));
    expect(view.message).toContain(
      mode === 'project'
        ? 'softwareagents'
        : mode === 'legacy'
          ? 'docs/backlog/board.json'
          : 'inválida',
    );
    expect(view.message).not.toContain('sin ronda activa');
    expect(view.configurationHint !== null).toBe(mode === 'project');
    expect(view.clickupLink).toBeNull();
  });
  it('links the configured ClickUp folder', () => {
    const view = backlogView({
      ...board('project'),
      clickupFolderUrl: 'https://app.clickup.com/123/v/f/456',
    });
    expect(view.clickupLink).toEqual({
      href: 'https://app.clickup.com/123/v/f/456',
      target: '_blank',
      rel: 'noopener noreferrer',
      label: 'Abrir carpeta de ClickUp',
    });
    expect(view.configurationHint).toBeNull();
    expect(view.message).toContain('SA-053');
  });
  it('handles absent and available board sources', () => {
    expect(backlogView(null).message).toContain('Modo legacy');
    const state = board('project');
    expect(backlogView({ ...state, sources: { ...state.sources, board: true } })).toMatchObject({
      message: null,
      configurationHint: null,
    });
  });
});
