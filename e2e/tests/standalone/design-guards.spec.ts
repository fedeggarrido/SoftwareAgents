import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import {
  coveredBy,
  diffBaseline,
  sweepDesign,
  WRITE_BASELINE,
  writeBaseline,
} from '../../helpers/designGuards';

/**
 * SA-151 design guards. Each screen is swept at desktop and mobile; violations
 * are compared with e2e/design-guards.baseline.json (new ones fail, fixed ones
 * must be trimmed). Regenerate the baseline after a reviewed burn-down with:
 *   PIXEL_AGENTS_DESIGN_BASELINE=write npm run e2e -- --grep @area:design
 * TODO(SA-151): add pixel-diff screenshot baselines once the UI settles, and a
 * seeded WorkStore fixture (backlog in every state, decisions, meeting).
 */

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 375, height: 812 },
} as const;
type ViewportName = keyof typeof VIEWPORTS;
const WINDOW_TABS = ['Trabajo', 'Decisiones', 'Auditoría', 'Funcionalidades', 'Reuniones'];
const CONNECTION_TIMEOUT_MS = 15_000;

async function dockButton(page: Page, viewport: ViewportName, name: string) {
  const direct = page.locator('.bottom-toolbar').getByRole('button', { name, exact: true });
  if (viewport === 'mobile' && !(await direct.isVisible())) {
    await page.getByRole('button', { name: 'Más', exact: true }).click();
  }
  await direct.click();
}

async function closeWindow(page: Page) {
  const close = page.getByRole('button', { name: 'Cerrar ventana', exact: true });
  if (await close.isVisible()) await close.click();
}

test.describe('Design guards (SA-151)', () => {
  for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
    test(`every screen meets the design rules at ${viewport} @area:design`, async ({
      page,
      standalone,
    }, testInfo) => {
      test.setTimeout(180_000);
      await page.setViewportSize(VIEWPORTS[viewport]);
      await standalone.drainMessages();
      await page.waitForTimeout(500);

      const failures: string[] = [];
      const check = async (screen: string) => {
        await page.waitForTimeout(300);
        await testInfo.attach(`${screen}-${viewport}.png`, {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
        record(screen, await sweepDesign(page, { screen, viewport }));
      };
      const record = (screen: string, keys: string[]) => {
        if (WRITE_BASELINE) {
          writeBaseline(screen, viewport, keys);
          return;
        }
        const { added, fixed } = diffBaseline(screen, viewport, keys);
        failures.push(
          ...added.map((k) => `NEW ${k}`),
          ...fixed.map((k) => `FIXED (trim baseline) ${k}`),
        );
      };

      // SA-160 motion tokens exist, so components can reference them.
      const tokens = await page.evaluate(() =>
        [
          '--duration-fast',
          '--duration-base',
          '--duration-slow',
          '--ease-out',
          '--ease-in-out',
        ].filter(
          (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() === '',
        ),
      );
      expect(tokens, 'missing motion tokens').toEqual([]);

      await check('office');

      await dockButton(page, viewport, 'Trabajo');
      for (const tab of WINDOW_TABS) {
        await page.getByRole('tab', { name: tab, exact: true }).click();
        await check(`window-${tab}`);
      }
      if (viewport === 'mobile') {
        // Layers: the sheet's close button is reachable and «Más» opens above the window.
        expect(await coveredBy(page, '[aria-label="Cerrar ventana"]')).toBeNull();
        await page.getByRole('button', { name: 'Más', exact: true }).click();
        expect(await coveredBy(page, '.dock-sheet button')).toBeNull();
        await page.keyboard.press('Escape');
      }
      await closeWindow(page);

      await dockButton(page, viewport, 'Nueva idea');
      await check('new-idea');
      await page.keyboard.press('Escape');
      await closeWindow(page);

      await dockButton(page, viewport, 'Ajustes');
      await check('settings');
      await page.keyboard.press('Escape');

      // Motion under reduced-motion: no transition or animation keeps running.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const moving = await page.evaluate(() =>
        [...document.querySelectorAll('body *')]
          .filter((el) => {
            const s = getComputedStyle(el);
            const timed = (v: string) => v.split(',').some((d) => parseFloat(d) > 0.01);
            return (
              (timed(s.transitionDuration) && !/^opacity$/.test(s.transitionProperty)) ||
              (s.animationName !== 'none' && timed(s.animationDuration))
            );
          })
          .map(
            (el) =>
              `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').split(/\s+/)[0]}`,
          ),
      );
      await page.emulateMedia({ reducedMotion: null });
      record(
        'reduced-motion',
        [...new Set(moving)].map((el) => `reduced-motion|${viewport}|motion-reduced|${el}`),
      );

      // Connection lost (SA-154): exactly one notice, not over the HUD, minimisable.
      await standalone.stopHost();
      const notice = page.getByTestId('connection-notice');
      await expect(notice).toHaveCount(1, { timeout: CONNECTION_TIMEOUT_MS });
      await check('connection-lost');
      const hud = page.locator('.company-hud').first();
      if (await hud.isVisible()) {
        const [a, b] = [await notice.boundingBox(), await hud.boundingBox()];
        if (a && b)
          expect(a.y + a.height <= b.y || b.y + b.height <= a.y, 'notice overlaps HUD').toBe(true);
      }
      await page.getByRole('button', { name: 'Minimizar aviso de conexión' }).click();
      await page.getByRole('button', { name: 'Mostrar aviso de conexión' }).click();
      await expect(page.getByTestId('connection-notice')).toHaveCount(1);
      await standalone.startHost();

      expect(failures, failures.join('\n')).toEqual([]);
    });
  }
});
