import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import type { TestHooksWindow } from '../../helpers/editor';
import { buildSeedLayout } from '../../helpers/layout-seed';
import { openSettingsModal } from '../../helpers/webview';

/** Saves a layout from `page` through the browser import, tagged by one area label. */
async function saveFrom(page: Page, dir: string, label: string): Promise<void> {
  const file = path.join(dir, `${label}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      buildSeedLayout({
        areas: [{ label, color: '#4287f5' }],
        areaTiles: [{ col: 1, row: 1, label }],
      }),
    ),
  );
  const modal = await openSettingsModal(page);
  await page.setInputFiles('input[type="file"]', file);
  await expect(modal).toBeHidden();
}

const areasOf = (page: Page) =>
  page.evaluate(() =>
    ((window as TestHooksWindow).__pixelAgentsTestHooks?.getAreas?.() ?? []).map(
      (area) => area.label,
    ),
  );

function savedLabels(tmpHome: string): string[] {
  const file = path.join(tmpHome, '.pixel-agents', 'layout.json');
  if (!fs.existsSync(file)) return [];
  const layout = JSON.parse(fs.readFileSync(file, 'utf8')) as { areas?: { label: string }[] };
  return (layout.areas ?? []).map((area) => area.label);
}

for (const keepMine of [false, true]) {
  test(`a stale save never silently replaces a newer layout from another tab (keep mine: ${keepMine}) @area:standalone`, async ({
    page,
    standalone,
  }) => {
    const other = await page.context().newPage();
    // The office drops the token from the address bar once connected; a second tab needs it.
    const otherUrl = new URL(page.url());
    otherUrl.searchParams.set('token', standalone.hookServerConfig.token);
    await other.goto(otherUrl.toString());
    await expect(other.locator('canvas').first()).toBeVisible();

    // The other tab saves first; this tab still edits from the older layout.
    await saveFrom(other, standalone.tmpHome, 'Newer');
    await expect.poll(() => savedLabels(standalone.tmpHome)).toEqual(['Newer']);

    const asked = new Promise<string>((resolve) => {
      page.once('dialog', (dialog) => {
        resolve(dialog.message());
        void (keepMine ? dialog.accept() : dialog.dismiss());
      });
    });
    await saveFrom(page, standalone.tmpHome, 'Stale');
    expect(await asked).toContain('diseño de la oficina más reciente');

    const winner = keepMine ? 'Stale' : 'Newer';
    await expect.poll(() => savedLabels(standalone.tmpHome)).toEqual([winner]);
    await expect.poll(() => areasOf(page)).toEqual([winner]);
    await other.close();
  });
}
