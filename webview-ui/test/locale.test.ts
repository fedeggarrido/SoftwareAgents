import { readFileSync } from 'node:fs';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { glossary } from '../src/i18n/glossary.js';
import { roleLabel } from '../src/i18n/roles.js';
import { decisionUrgency } from '../src/office/decisionOptions.js';
import { getPetName } from '../src/office/sprites/petSpriteData.js';

it('identifies the Spanish office in the browser tab with its own pixel favicon', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  expect(html).toContain('lang="es"');
  expect(html).toContain('<title>SoftwareAgents</title>');
  expect(html).not.toContain('vite.svg');
  const favicon = /href="([^"]+\.svg)"/.exec(html)?.[1];
  expect(favicon).toBeTruthy();
  expect(readFileSync(new URL(`../public${favicon}`, import.meta.url), 'utf8')).toContain('<svg');
});

it('translates runtime roles and urgency while preserving custom names', () => {
  expect(roleLabel('Tech Lead')).toBe('Responsable técnico');
  expect(roleLabel('company-manager')).toBe('Coordinador');
  expect(roleLabel('DEV')).toBe('Desarrollador');
  expect(roleLabel('Ada')).toBe('Ada');
  expect(decisionUrgency('medium')).toBe('media');
  expect(getPetName(99)).toBe('Mascota 100');
  expect(glossary.executor.explanation).toContain('con tu cuenta');
});

it('announces updates in Spanish with a named dismiss control', async () => {
  // Keep TSX outside the DOM-free test project.
  const componentPath = '../src/components/VersionIndicator.js';
  const { VersionIndicator } = await import(componentPath);
  const html = renderToStaticMarkup(
    createElement(VersionIndicator, {
      currentVersion: '1.4.1',
      lastSeenVersion: '1.3',
      onDismiss: () => {},
      onOpenChangelog: () => {},
    }),
  );
  expect(html).toContain('Actualizado a v1.4');
  expect(html).toContain('Ver novedades');
  expect(html).toContain('aria-label="Cerrar"');
  expect(html).not.toContain('Updated');
});
