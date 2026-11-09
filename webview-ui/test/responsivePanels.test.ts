import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';
import { chromium } from '@playwright/test';
import { build as bundle } from 'esbuild';
import { build } from 'vite';
import { expect, it } from 'vitest';

import {
  PANEL_WINDOW_MOVE_STEP_PX,
  PANEL_WINDOW_RESIZE_STEP_PX,
  PANEL_WINDOW_STORAGE_KEY,
} from '../src/constants.js';
import viteConfig from '../vite.config.ts';
type MatchableElement = { matches(selector: string): boolean };
type MeasurableElement = { scrollWidth: number; clientWidth: number };
const isOutsidePanelWindow = (element: unknown) =>
  (element as { closest(selector: string): unknown }).closest('[data-testid="panel-window"]') ===
  null;
const isFocusedElement = (element: unknown) => (element as MatchableElement).matches(':focus');
const fitsHorizontally = (element: unknown) =>
  (element as MeasurableElement).scrollWidth <= (element as MeasurableElement).clientWidth;

const board = {
  type: 'boardState',
  mode: 'project',
  project: 'Design demo with a very long project title',
  projectId: 'demo',
  items: [],
  recent: [],
  decisions: [],
  waiting: [],
  gate: [],
  sources: { board: true, workStore: true },
  summary: { total: 123, byPhase: { DONE: 12 }, byEpic: {} },
};

async function boot(page: Page) {
  await page.waitForFunction('window.officeSubscribed === true');
  const messages = [
    { type: 'layoutLoaded', layout: null },
    board,
    { type: 'officeAccess', privileged: true, reason: 'managed_process' },
    {
      type: 'executorState',
      projectId: 'demo',
      revision: 'r',
      sequence: 1,
      observedAt: 1,
      canManage: false,
      configurationStatus: 'ready',
      executors: [],
    },
  ];
  await page.evaluate(
    `for (const message of ${JSON.stringify(messages)}) window.postMessage(message, '*');`,
  );
  await page.getByRole('button', { name: 'Backlog', exact: true }).waitFor();
  await page.evaluate('document.fonts.ready');
}

it('uses one movable office window at 390/1024/1440px, with modal-first Escape and viewer persistence', async (context) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    context.skip(true, 'Playwright Chromium unavailable in sandbox');
    return;
  }
  try {
    const result = await build({
      ...viteConfig,
      configFile: false,
      cacheDir: path.resolve('../.vitest-tmp/responsive-vite'),
      logLevel: 'silent',
      build: { write: false },
    });
    const css = (Array.isArray(result) ? result : [result])
      .flatMap((output) => ('output' in output ? output.output : []))
      .filter((entry) => entry.type === 'asset' && entry.fileName.endsWith('.css'))
      .map((entry) => (entry.type === 'asset' ? String(entry.source) : ''))
      .join('\n');
    // Bundle App itself. Only the server transport is substituted.
    // TSX stays outside tsconfig.node and operator profiles stay isolated.
    const bundled = await bundle({
      stdin: {
        resolveDir: path.resolve('src'),
        loader: 'tsx',
        contents: `
          import { createRoot } from 'react-dom/client';
          import App from './App';
          let root;
          window.mountOffice = () => {
            root?.unmount();
            window.officeSubscribed = false;
            root = createRoot(document.getElementById('root'));
            root.render(<App />);
          };
          window.mountOffice();
        `,
      },
      define: { 'import.meta.env.DEV': 'false' },
      plugins: [
        {
          name: 'isolated-office-transport',
          setup(build) {
            build.onLoad({ filter: /[\\/]transport[\\/]index\.ts$/ }, () => ({
              loader: 'js',
              contents: `
              export const transport = {
                state: 'connected', ready: Promise.resolve(),
                onStateChange: () => () => {}, dispose() {},
                onMessage(handler) {
                  const listener = event => handler(event.data);
                  window.addEventListener('message', listener);
                  window.officeSubscribed = true;
                  return () => window.removeEventListener('message', listener);
                },
                send(message) {
                  if (message.type === 'requestFeatures') queueMicrotask(() => window.postMessage({
                    type: 'featuresSnapshot', projectId: message.projectId, requestId: message.requestId,
                    status: 'ok', reason: null, features: [{ key: 'FEAT-001', title: 'A feature',
                      state: 'in_design', rawStatus: null, progress: null, currentTask: null,
                      gates: [], integration: null, lastActivityAt: null,
                      cost: { executions: 0, costKnown: 0, costUsd: null, costPerDoneTaskUsd: null, cacheHitRate: null } }]
                  }, '*'));
                }
              };
            `,
            }));
          },
        },
      ],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
    });
    const script = `window.__PIXEL_AGENTS_E2E = true;\n${bundled.outputFiles[0].text}`;
    const font = readFileSync('public/fonts/FSPixelSansUnicode-Regular.ttf').toString('base64');
    const html = `<style>${css}\n@font-face { font-family: 'FS Pixel Sans'; src: url(data:font/ttf;base64,${font}); }</style><div id="root"></div>`;

    for (const width of [390, 1024, 1440]) {
      const page = await browser.newPage({
        viewport: { width, height: 844 },
        hasTouch: width === 390,
      });
      // A synthetic origin enables localStorage. All network requests are intercepted.
      await page.route('**/*', (route) =>
        route.request().isNavigationRequest()
          ? route.fulfill({ contentType: 'text/html', body: html })
          : route.abort(),
      );
      await page.goto('http://office-window.test/');
      await page.addScriptTag({ content: script });
      await boot(page);
      const windowPanel = page.locator('[data-testid="panel-window"]:visible');
      const backlog = page.getByRole('button', { name: 'Backlog', exact: true });
      const canvas = page.locator('canvas').first();
      const officeBox = await canvas.boundingBox();
      expect(await backlog.count()).toBe(1);
      await backlog.click();
      await windowPanel.waitFor();
      const panelBox = (await windowPanel.boundingBox())!;
      expect(await canvas.boundingBox()).toEqual(officeBox);
      expect(await page.getByRole('tab', { selected: true }).textContent()).toBe('Backlog');
      expect(await page.getByTestId('backlog-panel').count()).toBe(1);
      if (width === 390) {
        expect(panelBox).toEqual({ x: 0, y: 0, width: 390, height: 844 });
        expect(await page.locator('.panel-window-resize').count()).toBe(0);
        await page.locator('.panel-window-title').focus();
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Shift+ArrowDown');
        expect(await windowPanel.boundingBox()).toEqual(panelBox);
        await page.keyboard.press('Escape');
        expect(await backlog.evaluate(isFocusedElement)).toBe(true);
        const buttons = page.locator('.bottom-toolbar > button');
        await buttons.first().focus();
        for (const button of await buttons.all()) {
          const box = (await button.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
          expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24);
          expect(await button.evaluate(isFocusedElement)).toBe(true);
          await page.keyboard.press('Tab');
        }
        await backlog.tap();
      } else {
        const hud = (await page.getByTestId('company-hud').boundingBox())!;
        const zoom = (await page.getByTestId('zoom-controls').boundingBox())!;
        expect(hud.x).toBeGreaterThan(zoom.x + zoom.width);
        for (const locator of [
          page.getByTestId('zoom-controls'),
          page.getByTestId('company-hud'),
          page.locator('.office-mode-indicator'),
          page.locator('.bottom-toolbar'),
        ]) {
          const control = (await locator.boundingBox())!;
          expect(
            panelBox.x + panelBox.width <= control.x ||
              control.x + control.width <= panelBox.x ||
              panelBox.y + panelBox.height <= control.y ||
              control.y + control.height <= panelBox.y,
          ).toBe(true);
        }
        await page.getByRole('button', { name: 'Auditoría', exact: true }).click();
        expect(await windowPanel.count()).toBe(1);
        expect(await page.getByTestId('panel-window').count()).toBe(1);
        expect(await page.getByTestId('backlog-panel').count()).toBe(0);
        expect(await page.getByTestId('audit-panel').count()).toBe(1);
        await page.getByRole('button', { name: 'Auditoría', exact: true }).click();
        expect(await windowPanel.count()).toBe(0);
        await backlog.click();
      }
      expect(await page.getByTestId('company-hud').locator('.ui-counter').textContent()).toBe(
        '12 de 123 hechas',
      );
      expect(
        await page.evaluate(
          "getComputedStyle(document.querySelector('.ui-counter')).fontVariantNumeric",
        ),
      ).toContain('slashed-zero');
      for (const name of ['Auditoría', 'Features', 'Decisiones', 'Reuniones', 'Backlog']) {
        await page.getByRole('tab', { name, exact: true }).click();
        expect(await windowPanel.count()).toBe(1);
        expect(await page.getByRole('tabpanel').count()).toBe(1);
        expect(await page.getByRole('tab', { selected: true }).textContent()).toBe(name);
        const sections = windowPanel.locator('[data-testid$="-panel"]');
        // Empty meetings keep an informative message in their sole tab.
        expect(await sections.count()).toBe(name === 'Reuniones' ? 0 : 1);
        expect(await canvas.boundingBox()).toEqual(officeBox);
      }
      for (const sources of [{ board: false }, { board: true }]) {
        await page.evaluate(`window.postMessage(${JSON.stringify({ ...board, sources })}, "*")`);
        await page.waitForTimeout(30);
        expect(await backlog.count()).toBe(1);
        expect(await page.getByRole('button', { name: 'Tareas', exact: true }).count()).toBe(0);
      }
      await page.keyboard.press('Escape');
      expect(await windowPanel.count()).toBe(0);
      expect(await backlog.evaluate(isFocusedElement)).toBe(true);
      // Character details use the same window, including long legacy field values.
      await page.evaluate(`
        window.postMessage({ type: 'agentCreated', id: 1 }, '*');
        window.postMessage({ type: 'agentRole', id: 1, label: 'Developer', department: 'Ingeniería',
          characterDetail: { taskTitle: 'long'.repeat(200), worktree: 'path/'.repeat(100) } }, '*');
      `);
      await page.waitForFunction(
        'window.__pixelAgentsTestHooks.getCharacters().some(character => character.id === 1)',
      );
      await page.evaluate('window.__pixelAgentsTestHooks.selectAgent(1)');
      await page.getByRole('tab', { name: 'Personaje', selected: true }).waitFor();
      await page.getByTestId('character-detail-panel').waitFor();
      expect(await page.locator('[data-testid="panel-window"]:visible').count()).toBe(1);
      expect(await page.getByTestId('character-detail-panel').evaluate(fitsHorizontally)).toBe(
        true,
      );
      await page.getByRole('tab', { name: 'Backlog', exact: true }).click();
      expect(await page.getByTestId('character-detail-panel').count()).toBe(0);
      await page.keyboard.press('Escape');
      await page.evaluate('window.__pixelAgentsTestHooks.selectAgent(null)');
      // Let the real projection report deselection before remount/persistence assertions.
      await page.waitForTimeout(50);
      if (width === 390) {
        await backlog.tap();
        await page.getByRole('tab', { name: 'Features', exact: true }).tap();
        await page.getByRole('button', { name: 'Ver plan', exact: true }).tap();
        await page.getByRole('dialog', { name: 'Plan de feature', exact: true }).waitFor();
        await page.keyboard.press('Escape');
        expect(await page.getByRole('dialog').count()).toBe(0);
        expect(await windowPanel.count()).toBe(1);
        await page.keyboard.press('Escape');
        expect(await windowPanel.count()).toBe(0);
        await page.close();
        continue;
      }

      // Escape cannot reach the editor while either overlay is present.
      await page.getByRole('button', { name: 'Layout', exact: true }).click();
      await backlog.click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      expect(await page.getByRole('dialog').count()).toBe(0);
      expect(await windowPanel.count()).toBe(1);
      expect(
        await page
          .getByRole('button', { name: 'Settings', exact: true })
          .evaluate(isFocusedElement),
      ).toBe(true);
      await page.keyboard.press('Escape');
      expect(await windowPanel.count()).toBe(0);
      expect(await backlog.evaluate(isFocusedElement)).toBe(true);
      expect(
        await page.getByRole('button', { name: 'Layout', exact: true }).getAttribute('class'),
      ).toContain('bg-active-bg');
      await page.getByRole('button', { name: 'Layout', exact: true }).click();

      await page.getByRole('button', { name: 'Features', exact: true }).click();
      await page.getByRole('button', { name: 'Ver plan', exact: true }).click();
      const plan = page.getByRole('dialog', { name: 'Plan de feature', exact: true });
      await plan.waitFor();
      expect(await plan.evaluate(isOutsidePanelWindow)).toBe(true);
      await page.keyboard.press('Escape');
      expect(await plan.count()).toBe(0);
      expect(await windowPanel.count()).toBe(1);
      expect(
        await page
          .getByRole('button', { name: 'Ver plan', exact: true })
          .evaluate(isFocusedElement),
      ).toBe(true);
      await page.getByRole('button', { name: 'Nueva idea', exact: true }).click();
      await page.getByRole('dialog', { name: 'Nueva idea', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      expect(await page.getByRole('dialog').count()).toBe(0);
      expect(await windowPanel.count()).toBe(1);

      const title = page.locator('.panel-window-title');
      const before = (await windowPanel.boundingBox())!;
      const titleBox = (await title.boundingBox())!;
      await page.mouse.move(titleBox.x + 30, titleBox.y + 20);
      await page.mouse.down();
      await page.mouse.move(titleBox.x + 78, titleBox.y + 52);
      await page.mouse.up();
      const dragged = (await windowPanel.boundingBox())!;
      expect(dragged.x).toBe(before.x + 48);
      expect(dragged.y).toBe(before.y + 32);
      await title.focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Shift+ArrowRight');
      const keyboardBox = (await windowPanel.boundingBox())!;
      expect(keyboardBox.x).toBe(dragged.x + PANEL_WINDOW_MOVE_STEP_PX);
      expect(keyboardBox.width).toBe(dragged.width + PANEL_WINDOW_RESIZE_STEP_PX);
      const corner = (await page.locator('.panel-window-resize-se').boundingBox())!;
      await page.mouse.move(corner.x + 4, corner.y + 4);
      await page.mouse.down();
      await page.mouse.move(corner.x + 28, corner.y + 28);
      await page.mouse.up();
      const resized = await windowPanel.boundingBox();
      expect(resized!.width).toBe(keyboardBox.width + 24);
      expect(resized!.height).toBe(keyboardBox.height + 24);
      await page.waitForFunction(
        (key) => JSON.parse(localStorage.getItem(key) ?? '{}').lastTab === 'features',
        PANEL_WINDOW_STORAGE_KEY,
      );
      const saved = await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!),
        PANEL_WINDOW_STORAGE_KEY,
      );
      expect(saved.rect).toEqual({
        x: resized!.x,
        y: resized!.y,
        width: resized!.width,
        height: resized!.height,
      });
      await page.evaluate('window.mountOffice()');
      await boot(page);
      expect(
        await page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key)!).lastTab,
          PANEL_WINDOW_STORAGE_KEY,
        ),
      ).toBe('features');
      await page.getByRole('button', { name: 'Features', exact: true }).click();
      expect(await windowPanel.boundingBox()).toEqual(resized);
      await page.setViewportSize({ width: 600, height: 400 });
      const shrunkTitle = (await title.boundingBox())!;
      expect(shrunkTitle.x).toBeGreaterThanOrEqual(0);
      expect(shrunkTitle.x + shrunkTitle.width).toBeLessThanOrEqual(600);
      expect(shrunkTitle.y).toBeGreaterThanOrEqual(0);
      expect(shrunkTitle.y + shrunkTitle.height).toBeLessThanOrEqual(400);
      await page.setViewportSize({ width, height: 844 });
      await page.getByRole('button', { name: 'Restablecer posición', exact: true }).click();
      const reset = (await windowPanel.boundingBox())!;
      expect(reset.x).toBe(panelBox.x);
      expect(reset.width).toBe(panelBox.width);
      await page.close();
    }
    for (const storage of ['corrupt', 'unavailable']) {
      const page = await browser.newPage({ viewport: { width: 1024, height: 844 } });
      await page.route('**/*', (route) =>
        route.request().isNavigationRequest()
          ? route.fulfill({ contentType: 'text/html', body: html })
          : route.abort(),
      );
      await page.goto('http://office-window.test/');
      await page.evaluate(
        storage === 'corrupt'
          ? `localStorage.setItem(${JSON.stringify(PANEL_WINDOW_STORAGE_KEY)}, '{broken')`
          : `Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage unavailable'); } })`,
      );
      await page.addScriptTag({ content: script });
      await boot(page);
      await page.getByRole('button', { name: 'Backlog', exact: true }).click();
      const box = (await page.locator('[data-testid="panel-window"]:visible').boundingBox())!;
      expect(box.x).toBe(64);
      expect(box.width).toBe(720);
      await page.locator('.panel-window-title').focus();
      await page.keyboard.press('ArrowRight');
      expect((await page.locator('[data-testid="panel-window"]:visible').boundingBox())!.x).toBe(
        box.x + PANEL_WINDOW_MOVE_STEP_PX,
      );
      await page.keyboard.press('Escape');
      expect(await page.locator('[data-testid="panel-window"]:visible').count()).toBe(0);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}, 60_000);
