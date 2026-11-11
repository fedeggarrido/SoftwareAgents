import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { BoardState, CharacterDetail } from '../../core/src/messages.js';
import { AGENT_HISTORY_LIMIT } from '../src/constants.js';
import type { AgentHistoryEvent } from '../src/office/agentHistory.js';
import { agentElapsed, AgentHistory, agentTask } from '../src/office/agentHistory.js';

// Runtime path keeps TSX outside the DOM-free TypeScript test project.
const panelPath = '../src/components/CharacterDetailPanel.js';
async function render(detail?: Partial<CharacterDetail>, history?: readonly AgentHistoryEvent[]) {
  const { CharacterDetailPanel } = await import(panelPath);
  return renderToStaticMarkup(
    createElement(CharacterDetailPanel, {
      name: 'Ada',
      role: 'Developer',
      detail: detail as CharacterDetail,
      history,
      onOpenBacklog: () => {},
      onCloseAgent: () => {},
    }),
  );
}

describe('agent card', () => {
  it('names the dialog, renders known facts and hides unknown fields and UUIDs', async () => {
    const html = await render({
      taskKey: 'SA-119',
      taskTitle: '<script>unsafe</script>',
      model: 'gpt-test',
      executor: 'codex',
      elapsed: '10 s',
      role: 'developer',
      tier: 'desconocido',
      taskStatus: 'RUNNING',
      worktree: 'desconocido',
    });
    expect(html).toContain('role="dialog"');
    expect(html).toMatch(/aria-labelledby="([^"]+)"/);
    const nameId = html.match(/aria-labelledby="([^"]+)"/)![1];
    expect(html).toContain(`<h2 id="${nameId}" class="text-lg">Ada</h2>`);
    expect(html).toContain('Ada');
    expect(html).toContain('Developer');
    for (const text of [
      'Ahora',
      'SA-119',
      'gpt-test',
      'codex',
      '10 s',
      'Historial',
      'Ver en Trabajo',
      'Cerrar agente',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('desconocido');
    const empty = await render({
      taskKey: '3b547b5e-b1a1-4ed5-8cde-f152b6f47894',
      taskTitle: 'desconocido',
      model: 'unknown',
      executor: '',
      elapsed: 'desconocido',
    });
    expect(empty).not.toMatch(/3b547b5e|desconocido|unknown|<dt>Modelo|<h3>Ahora/);
    expect(empty).toContain('Aún no hay actividad');
  });
  it('shows newest events first with relative time and caps the rendered list', async () => {
    const now = Date.now();
    const events = Array.from({ length: AGENT_HISTORY_LIMIT + 2 }, (_, i) => ({
      key: String(i),
      at: now - (AGENT_HISTORY_LIMIT + 2 - i) * 60_000,
      text: `Evento ${i}!`,
    }));
    const html = await render(undefined, events);
    expect(html.indexOf('Evento 11!')).toBeLessThan(html.indexOf('Evento 10!'));
    expect(html).not.toContain('Evento 0!');
    expect(html.match(/<li>/g)).toHaveLength(AGENT_HISTORY_LIMIT);
    expect(html).toContain('hace 1 min');
  });
  it('keeps per-agent bounded buffers, deduplicates tools and cleans removed sessions', () => {
    const history = new AgentHistory();
    for (let i = 0; i < AGENT_HISTORY_LIMIT + 5; i++)
      history.receive(
        { type: 'agentToolStart', id: 1, toolId: String(i), toolName: 'Read', status: 'Reading' },
        i,
      );
    history.receive(
      { type: 'agentToolStart', id: 1, toolId: '14', toolName: 'Read', status: 'Reading' },
      99,
    );
    history.receive(
      { type: 'agentToolStart', id: 2, toolId: 'other', toolName: 'Bash', status: 'Running' },
      100,
    );
    expect(history.events(1)).toHaveLength(AGENT_HISTORY_LIMIT);
    expect(history.events(1)[0].at).toBe(14);
    expect(history.events(1).at(-1)?.at).toBe(5);
    expect(history.events(2)).toHaveLength(1);
    history.receive({ type: 'agentToolsClear', id: 2 });
    history.receive({
      type: 'existingAgents',
      agents: [2],
      agentMeta: {},
      folderNames: {},
      externalAgents: {},
    });
    expect(history.events(2)).toHaveLength(1);
    history.receive({ type: 'agentClosed', id: 1 });
    expect(history.events(1)).toHaveLength(0);
    expect(history.events(2)).toHaveLength(1);
  });
  it('records started, completed and failed task events only for the matching project and role', () => {
    const history = new AgentHistory();
    history.receive({ type: 'agentCreated', id: 1, projectId: 'p' });
    history.receive({
      type: 'agentRole',
      id: 1,
      label: 'Developer',
      department: 'Ingeniería',
      detail: 'tarea SA-119',
      characterDetail: { projectId: 'p', taskKey: 'SA-119', role: 'developer' } as CharacterDetail,
    });
    const event = {
      projectId: 'p',
      taskKey: 'SA-119',
      agentRole: 'developer',
      executionId: null,
      eventId: 1,
      at: 100,
      kind: 'execution.started' as const,
    };
    history.receive({ type: 'domainEvent', event });
    history.receive({ type: 'domainEvent', event });
    history.receive({ type: 'domainEvent', event: { ...event, projectId: 'other', eventId: 2 } });
    history.receive({
      type: 'domainEvent',
      event: { ...event, eventId: 3, at: 300, kind: 'task.state_changed', toStatus: 'DONE' },
    });
    history.receive({
      type: 'domainEvent',
      event: {
        ...event,
        eventId: 4,
        at: 400,
        kind: 'task.state_changed',
        toStatus: 'FAILED_FINAL',
      },
    });
    expect(history.events(1).map((row) => row.text)).toEqual([
      'Falló la tarea SA-119',
      'Terminó la tarea SA-119',
      'Inició la tarea SA-119',
    ]);
    expect(
      agentTask(1, { label: 'Developer', department: 'x', detail: 'tarea SA-119' }, 'p'),
    ).toEqual({ key: 'SA-119', title: undefined });
  });
  it('retains task completion from board history after the board stops assigning the character', () => {
    const history = new AgentHistory();
    history.receive({ type: 'agentCreated', id: 1, projectId: 'p' });
    history.receive({
      type: 'agentRole',
      id: 1,
      label: 'Developer',
      department: 'Ingeniería',
      detail: 'tarea SA-119',
    });
    history.receive({ type: 'agentRole', id: 1, label: 'Developer', department: 'Ingeniería' });
    history.receive({
      type: 'boardState',
      projectId: 'p',
      items: [{ id: 'SA-119', title: 'Tarjeta', phase: 'DONE', agentIds: [] }],
      recent: [
        { at: 200, phase: 'DONE', task: 'SA-119', session: 'SA-119', state: '', detail: '' },
      ],
      project: 'Demo',
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
      gate: [],
      waiting: [],
      decisions: [],
      summary: { total: 1, byPhase: { DONE: 1 }, byEpic: {} },
      generatedAt: 200,
    } satisfies BoardState);
    expect(history.events(1)[0].text).toBe('Terminó la tarea SA-119');
    history.clear();
    expect(history.events(1)).toHaveLength(0);
  });
  it('advances only a known running-task duration', () => {
    expect(
      agentElapsed({ elapsed: '10 s', taskStatus: 'RUNNING' } as CharacterDetail, 1000, 6000),
    ).toBe('15 s');
    expect(agentElapsed({ elapsed: 'desconocido' } as CharacterDetail, 1000, 6000)).toBeUndefined();
  });
});
