import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

// Resolve at runtime to keep TSX out of tsconfig.node's DOM-free graph.
const checkboxPath = '../src/components/ui/Checkbox.js';
const menuItemPath = '../src/components/ui/MenuItem.js';

it('associates each checkbox help with a unique accessible description', async () => {
  const { Checkbox } = await import(checkboxPath);
  const html = renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(Checkbox, {
        label: 'Uno',
        help: 'Primera ayuda',
        checked: false,
        onChange() {},
      }),
      createElement(Checkbox, {
        label: 'Dos',
        help: 'Segunda ayuda',
        checked: true,
        onChange() {},
      }),
    ),
  );
  const ids = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(2);
  for (const id of ids) expect(html).toContain(`id="${id}" class="setting-help"`);
  expect(html).toContain('aria-checked="false"');
  expect(html).toContain('aria-checked="true"');
});

it('associates action help without adding an empty description to other menu items', async () => {
  const { MenuItem } = await import(menuItemPath);
  const html = renderToStaticMarkup(
    createElement(MenuItem, { help: 'Explica la acción', onClick() {} }, 'Acción'),
  );
  const id = html.match(/aria-describedby="([^"]+)"/)?.[1];
  expect(id).toBeTruthy();
  expect(html).toContain(`id="${id}" class="setting-help"`);
  const plain = renderToStaticMarkup(createElement(MenuItem, { onClick() {} }, 'Acción'));
  expect(plain).not.toContain('aria-describedby');
});
