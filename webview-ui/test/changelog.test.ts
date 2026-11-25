import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { PROJECT_URL, UPSTREAM_URL, upstreamContributors } from '../src/changelogData.js';
import { es } from '../src/i18n/es.js';

it('keeps the MIT attribution of the original project and links our own', () => {
  const license = readFileSync(new URL('../../LICENSE', import.meta.url), 'utf8');
  const holder = /Copyright \(c\) .*/.exec(license)![0].trim();
  expect(es.changelog.attribution).toContain(holder);
  expect(es.changelog.attribution).toContain('MIT');
  expect(UPSTREAM_URL).toContain('pixel-agents-hq');
  expect(PROJECT_URL).not.toContain('pixel-agents');
  expect(new Set(upstreamContributors.map(({ name }) => name)).size).toBe(
    upstreamContributors.length,
  );
  expect(upstreamContributors.map(({ name }) => name)).toContain('@pablodelucca');
});

it('describes SoftwareAgents without the original engine jargon', () => {
  const text = JSON.stringify(es.changelog.sections);
  expect(text).not.toMatch(/AsyncAPI|hooks|Playwright|Discord|Tailwind|WebSocket/i);
  expect(text).toMatch(/entrevista/);
  expect(text).toMatch(/investigaciones/i);
  expect(text).toMatch(/apruebas/);
});
