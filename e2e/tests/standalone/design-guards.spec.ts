import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import {
  coveredBy,
  diffBaseline,
  sweepDesign,
  WRITE_BASELINE,
  writeBaseline,
} from '../../helpers/designGuards';
import { launchStandalone } from '../../helpers/standalone';

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
// The dock is the only panel navigation (no duplicate tabs inside the window).
const WINDOW_PANELS = ['Decisiones', 'Auditoría', 'Funcionalidades'];
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
  test('critical blockers remain actionable with the HUD collapsed (SA-118) @area:design', async ({
    page,
  }, testInfo) => {
    const homeDir = testInfo.outputPath('home');
    const workspaceDir = testInfo.outputPath('workspace');
    fs.mkdirSync(path.join(workspaceDir, '.softwareagents'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, '.softwareagents', 'project.yaml'),
      'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: blockers-e2e\nname: Blockers fixture\nrepo:\n  remote: https://example.invalid/blockers.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n',
    );
    fs.mkdirSync(path.join(homeDir, '.pixel-agents'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.pixel-agents', 'config.json'),
      JSON.stringify({
        projects: { 'blockers-e2e': { autonomyLevel: 'A1', allowedExecutors: [] } },
        hooksConsent: { claude: 'granted' },
      }),
    );
    const session = await launchStandalone(page, { homeDir, workspaceDir });
    try {
      for (const viewport of Object.values(VIEWPORTS)) {
        await page.setViewportSize(viewport);
        const hud = page.getByTestId('company-hud');
        const toggle = hud.locator('button[aria-expanded]');
        const banner = hud.getByTestId('critical-blocker');
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(banner).toContainText('todos los ejecutores están desactivados');
        const action = banner.getByRole('button', { name: 'Ver ejecutores', exact: true });
        await expect(action).toBeVisible();
        const [buttonBox, dockBox] = await Promise.all([
          action.boundingBox(),
          page.locator('.bottom-toolbar').boundingBox(),
        ]);
        expect(buttonBox!.height).toBeGreaterThanOrEqual(44);
        expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(dockBox!.y);
        await action.click();
        await expect(hud.getByTestId('executor-panel')).toBeVisible();
        await expect(hud.locator('.hud-executors')).toBeFocused();
        await expect(hud.getByRole('switch')).toHaveCount(2);
        await expect(banner).toBeVisible();
        await toggle.click();
      }
    } finally {
      await session.cleanup();
    }
  });

  for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
    test(`empty first screen explains the next step at ${viewport} (SA-117) @area:design`, async ({
      page,
      standalone,
    }, testInfo) => {
      await standalone.drainMessages();
      await page.setViewportSize(VIEWPORTS[viewport]);
      const welcome = page.getByRole('region', { name: 'Empieza con una idea' });
      await expect(welcome).toBeVisible();
      await expect(welcome).toContainText('Coordina agentes de IA para construir software');
      await expect(page.getByTestId('hud-pulse')).toHaveText(
        'Nadie trabajando · nada espera tu revisión',
      );
      await expect(page.getByTestId('company-hud')).not.toContainText('Capacidad observada');
      const action = welcome.getByRole('button', { name: 'Nueva idea', exact: true });
      const [cardBox, hudBox, dockBox, actionBox] = await Promise.all([
        welcome.boundingBox(),
        page.getByTestId('company-hud').boundingBox(),
        page.locator('.bottom-toolbar').boundingBox(),
        action.boundingBox(),
      ]);
      expect(cardBox!.y).toBeGreaterThanOrEqual(hudBox!.y + hudBox!.height);
      expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(dockBox!.y);
      expect(cardBox!.x).toBeGreaterThanOrEqual(0);
      expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(VIEWPORTS[viewport].width);
      expect(actionBox!.height).toBeGreaterThanOrEqual(44);
      await action.focus();
      await expect(action).toBeFocused();
      await testInfo.attach(`empty-office-${viewport}.png`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
      await action.press('Enter');
      await expect(page.getByRole('dialog', { name: 'Nueva idea', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await closeWindow(page);
      await welcome.getByRole('button', { name: 'Ocultar bienvenida' }).click();
      await expect(welcome).toHaveCount(0);
      await dockButton(page, viewport, 'Nueva idea');
      await expect(page.getByRole('dialog', { name: 'Nueva idea', exact: true })).toBeVisible();
    });

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

      await dockButton(page, viewport, 'Trabajo pendiente');
      await check('window-Trabajo');
      expect(await page.getByRole('tab').count()).toBe(0);
      for (const panel of WINDOW_PANELS) {
        await dockButton(page, viewport, panel);
        await check(`window-${panel}`);
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
