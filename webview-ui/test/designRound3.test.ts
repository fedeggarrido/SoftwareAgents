import { readFileSync } from 'node:fs';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

it('gives audit fields a boundary above 3:1 against both panel and field backgrounds', () => {
  const css = readFileSync('src/index.css', 'utf8');
  const color = (token: string) => css.match(new RegExp(`--color-${token}: #([0-9a-f]{6})`))![1];
  const luminance = (hex: string) => {
    const rgb = hex.match(/../g)!.map((value) => {
      const channel = parseInt(value, 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  expect(css).toMatch(/\.audit-filters select\s*\{\s*border: 2px solid var\(--color-text-muted\)/);
  for (const bg of ['bg', 'bg-dark']) {
    expect(
      (luminance(color('text-muted')) + 0.05) / (luminance(color(bg)) + 0.05),
    ).toBeGreaterThanOrEqual(3);
  }
  expect(css).toMatch(
    /\.feature-command\s*\{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/,
  );
});

it.each(['demo', '1.4.1'])('labels version %s with context', async (version) => {
  const modulePath = '../src/components/VersionIndicator.js';
  const { VersionIndicator } = await import(modulePath);
  const html = renderToStaticMarkup(
    createElement(VersionIndicator, {
      currentVersion: version,
      lastSeenVersion: version,
      onDismiss: () => {},
      onOpenChangelog: () => {},
    }),
  );
  expect(html).toContain(version === 'demo' ? 'versión: demo' : 'v1.4.1');
  expect(html).not.toContain('vdemo');
});
