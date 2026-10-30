import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { CharacterDetail } from '../../core/src/messages.js';

// Dynamic path keeps TSX out of the DOM-free test project's dependency graph.
const panelPath = '../src/components/CharacterDetailPanel.js';
async function render(detail?: CharacterDetail) {
  const { CharacterDetailPanel } = await import(panelPath);
  return renderToStaticMarkup(createElement(CharacterDetailPanel, { detail }));
}
describe('selected character detail', () => {
  it('renders complete server facts as text without actions', async () => {
    const html = await render({
      projectId: 'p',
      spec: 'developer@1.0.0',
      role: 'developer',
      taskKey: 'SA-049',
      taskTitle: '<script>secret</script>',
      taskStatus: 'RUNNING',
      executor: 'codex',
      model: 'model',
      tier: 'deep',
      effort: 'high',
      elapsed: '10 s',
      worktree: 'x'.repeat(500),
      branch: 'sa/task',
      pr: 'desconocido',
      selectionReason: 'policy',
      permissions: 'branch_write',
      log: '/logs/run.jsonl',
    });
    for (const value of [
      'developer@1.0.0',
      'SA-049',
      'model',
      'deep',
      'high',
      '10 s',
      'sa/task',
      'policy',
      'branch_write',
      '/logs/run.jsonl',
    ])
      expect(html).toContain(value);
    expect(html).toContain('role="region"');
    expect(html).toContain('read-only-panel');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<button');
  });
  it('renders unknown fields for an empty projection or a character without a task', async () => {
    const html = await render();
    expect(html).toContain('Detalle del personaje');
    expect(html.match(/desconocido/g)!.length).toBeGreaterThanOrEqual(17);
    expect(html).toContain('Título');
    expect(html).toContain('Último evento');
  });
});
