import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';

import { CLAUDE_CODE_INSTALL_COMMAND } from '../src/constants.js';

const hooks = vi.hoisted(() => ({ cursor: 0 }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => [hooks.cursor++ === 1 ? 1 : initial, vi.fn()],
}));
vi.mock('../src/transport/index.js', () => ({ transport: {} }));
afterEach(() => {
  hooks.cursor = 0;
});

// Runtime paths keep TSX outside tsconfig.node.json.
it('keeps the tour installation command inside a closed Detalles', async () => {
  const componentPath = '../src/components/IntroBubble.js';
  const { IntroBubble } = await import(componentPath);
  const html = renderToStaticMarkup(
    createElement(IntroBubble, {
      officeState: { greeter: null },
      containerRef: { current: { getBoundingClientRect: () => ({ width: 800, height: 600 }) } },
      panRef: { current: { x: 0, y: 0 } },
      zoom: 1,
    }),
  );
  expect(html).toContain(CLAUDE_CODE_INSTALL_COMMAND);
  expect(html).toMatch(/<details><summary>Detalles<\/summary>/);
  const visible = html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, '');
  expect(visible).not.toContain(CLAUDE_CODE_INSTALL_COMMAND);
  expect(visible).not.toContain('este comando');
  expect(html).not.toMatch(/<details[^>]*\bopen/);
});

it('keeps every CLI instruction in idea next steps inside closed Detalles', async () => {
  const componentPath = '../src/components/IdeaNextSteps.js';
  const { IdeaNextSteps } = await import(componentPath);
  const html = renderToStaticMarkup(createElement(IdeaNextSteps));
  const visible = html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, '');
  for (const command of ['research run', 'feature spec', 'feature approve', 'research review']) {
    expect(html).toContain(command);
    expect(visible).not.toContain(command);
  }
  expect(visible).not.toContain('ejecutar el comando');
  expect(html).not.toMatch(/<details[^>]*\bopen/);
});
