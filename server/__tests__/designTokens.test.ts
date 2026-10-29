import * as fs from 'fs';
import * as path from 'path';
import { expect, it } from 'vitest';

import { contrastRatio } from '../src/designer.js';

const css = fs.readFileSync(path.resolve('../webview-ui/src/index.css'), 'utf8');
const token = (name: string) => {
  const hex = css.match(new RegExp(`--${name}: #([0-9a-f]{6});`))?.[1];
  expect(hex, name).toBeDefined();
  return [0, 2, 4].map((offset) => parseInt(hex!.slice(offset, offset + 2), 16));
};

it('normal and muted text meet AA on panel and error backgrounds', () => {
  for (const text of ['color-text', 'color-text-muted', 'color-accent-bright'])
    for (const bg of ['color-bg', 'color-bg-dark', 'color-error-bg'])
      expect(contrastRatio(token(text), token(bg)), `${text} on ${bg}`).toBeGreaterThanOrEqual(4.5);
});

it('error border meets non-text contrast inside and outside the error block', () => {
  for (const bg of ['color-bg', 'color-error-bg'])
    expect(contrastRatio(token('color-error-border'), token(bg))).toBeGreaterThanOrEqual(3);
});
