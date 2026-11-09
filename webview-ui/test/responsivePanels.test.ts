import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';
import { chromium } from '@playwright/test';
import { build as bundle } from 'esbuild';
import { build } from 'vite';
import { expect, it } from 'vitest';

import {
  PANEL_WINDOW_MIN_HEIGHT_PX,
  PANEL_WINDOW_MIN_WIDTH_PX,
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

async function expectModalFocus(page: Page, name: string) {
  // Wait a frame so deferred cleanup restores have had an opportunity to run.
  expect(
    await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find(el =>
      el.textContent.includes(${JSON.stringify(name)}));
    resolve(!!dialog?.contains(document.activeElement));
  }))`),
  ).toBe(true);
  for (const key of ['Tab', 'Shift+Tab', 'Tab']) {
    await page.keyboard.press(key);
    expect(await page.evaluate('!!document.activeElement?.closest(\'[role="dialog"]\')')).toBe(
      true,
    );
  }
}

async function expectControlsClear(page: Page) {
  await expect
    .poll(async () => {
      const panel = (await page.getByTestId('panel-window').boundingBox())!;
      const controls = await Promise.all(
        [
          page.getByTestId('company-hud'),
          page.locator('.office-notices'),
          page.getByTestId('zoom-controls'),
          page.locator('.bottom-toolbar'),
        ].map((control) => control.boundingBox()),
      );
      return controls.every(
        (control) =>
          !control ||
          panel.x + panel.width <= control.x ||
          control.x + control.width <= panel.x ||
          panel.y + panel.height <= control.y ||
          control.y + control.height <= panel.y,
      );
    })
    .toBe(true);
  const title = (await page.locator('.panel-window-title').boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(title.y).toBeGreaterThanOrEqual(0);
  expect(title.y + title.height).toBeLessThanOrEqual(viewport.height);
}

async function expectWindowOwnsHeading(page: Page, name: string) {
  const panel = page.getByRole('tabpanel', { name, exact: true });
  expect(await panel.count()).toBe(1);
  const tab = page.getByRole('tab', { name, exact: true });
  expect(await panel.getAttribute('aria-labelledby')).toBe(await tab.getAttribute('id'));
  expect(await panel.locator('h2').count()).toBe(0);
  expect(await panel.getByRole('button', { name: /cerrar|✕/i }).count()).toBe(0);
  expect(await page.getByRole('button', { name: 'Cerrar ventana', exact: true }).count()).toBe(1);
}

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
          import { StrictMode } from 'react';
          import { flushSync } from 'react-dom';
          import { createRoot } from 'react-dom/client';
          import App from './App';
          import { NewIdeaDialog } from './components/NewIdeaDialog';
          import { FeaturePlanDialog } from './components/FeaturePlanDialog';
          let root;
          window.mountOffice = () => {
            root?.unmount();
            window.officeSubscribed = false;
            root = createRoot(document.getElementById('root'));
            root.render(<StrictMode><App /></StrictMode>);
          };
          window.mountOffice();
          window.showFocusProbe = kind => flushSync(() => root.render(<StrictMode>{
            kind === 'idea' ? <NewIdeaDialog onClose={() => {}} /> :
            <FeaturePlanDialog projectId="demo" featureKey="FEAT-001" onClose={() => {}} />
          }</StrictMode>));
          const renderStack = idea => root.render(<StrictMode>
            <FeaturePlanDialog projectId="demo" featureKey="FEAT-001" onClose={() => {}} />
            {idea && <NewIdeaDialog onClose={() => {}} />}
          </StrictMode>);
          window.showStackedFocusProbe = () => flushSync(() => renderStack(true));
          window.closeStackedFocusProbe = () => {
            flushSync(() => renderStack(false));
            document.querySelector('[role="dialog"] button').focus();
          };
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

        // Existing geometry must follow both expanding controls and viewport changes.
        await page.getByTestId('company-hud').locator('button[aria-expanded]').first().click();
        await page.locator('.office-mode-indicator button').click();
        await page.locator('#office-mode-explanation').waitFor();
        await expectControlsClear(page);
        await page.setViewportSize({ width: width === 1024 ? 1440 : 1024, height: 844 });
        await expectControlsClear(page);
        await page.setViewportSize({ width, height: 844 });
        await expectControlsClear(page);
        await page.locator('.office-mode-indicator button').click();
        await page.getByTestId('company-hud').locator('button[aria-expanded]').first().click();
        await page.getByRole('button', { name: 'Restablecer posición', exact: true }).click();
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
        await expectWindowOwnsHeading(page, name);
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
      const meeting = {
        id: 'meeting-1',
        format: 'delphi',
        topic: 'Meeting activity',
        question: 'What next?',
        participants: [],
        status: 'running',
        round: 'borrador',
        lines: [],
      };
      const sendMeeting = async (id: string) => {
        await page.evaluate(
          `window.postMessage(${JSON.stringify({ ...board, meeting: { ...meeting, id } })}, '*')`,
        );
        await page
          .getByTestId('company-hud')
          .getByRole('button', { name: /Reuniones/ })
          .waitFor();
      };
      // A new meeting opens a closed window, without stealing another open tab.
      await sendMeeting('meeting-1');
      await page.getByRole('tab', { name: 'Reuniones', selected: true }).waitFor();
      await expectWindowOwnsHeading(page, 'Reuniones');
      const meetingDetails = page
        .getByRole('tabpanel')
        .getByRole('button', { name: /Ocultar detalles/ });
      await meetingDetails.click();
      expect(
        await page.getByRole('button', { name: /Mostrar detalles/ }).getAttribute('aria-expanded'),
      ).toBe('false');
      await page.getByRole('button', { name: /Mostrar detalles/ }).click();
      await page.getByTestId('meeting-panel').waitFor();
      await page.keyboard.press('Escape');
      await backlog.click();
      await sendMeeting('meeting-2');
      const meetingTab = page.getByRole('tab', { name: 'Reuniones', exact: true });
      const meetingHud = page.getByTestId('company-hud').getByRole('button', { name: /Reuniones/ });
      await meetingTab.getByRole('status', { name: 'Nueva actividad' }).waitFor();
      expect(await page.getByRole('tab', { name: 'Backlog', selected: true }).count()).toBe(1);
      expect(await meetingHud.getByRole('status', { name: 'Nueva actividad' }).isVisible()).toBe(
        true,
      );
      await sendMeeting('meeting-2');
      expect(await meetingTab.getByRole('status').count()).toBe(1);
      // The mobile sheet covers the HUD and dock until dismissed.
      if (width === 390) await page.keyboard.press('Escape');
      await meetingHud.click();
      await page.getByRole('tab', { name: 'Reuniones', selected: true }).waitFor();
      expect(await meetingTab.getByRole('status').count()).toBe(0);
      expect(await meetingHud.getByRole('status').count()).toBe(0);
      if (width !== 390) {
        await meetingHud.click();
        expect(await windowPanel.count()).toBe(1);
      }
      await page.getByRole('tab', { name: 'Backlog', exact: true }).click();
      await sendMeeting('meeting-3');
      await meetingTab.getByRole('status').waitFor();
      await meetingTab.click();
      expect(await meetingHud.getByRole('status').count()).toBe(0);
      // Both HUD counts remain stable shortcuts to the same named section.
      const decisions = [
        { id: 'd1', status: 'open', question: 'One?', options: [] },
        { id: 'd2', status: 'open', question: 'Two?', options: [] },
      ];
      await page.evaluate(
        `window.postMessage(${JSON.stringify({
          ...board,
          decisions,
          items: [
            {
              id: 'task-pr',
              title: 'Task PR',
              phase: 'REVIEW',
              agentIds: [],
              prRef: 'demo/repo#1',
            },
          ],
        })}, '*')`,
      );
      const decisionHud = page.getByRole('button', {
        name: 'Decisiones, 2 pendientes',
        exact: true,
      });
      if (width === 390) await page.keyboard.press('Escape');
      await decisionHud.click();
      expect(await decisionHud.textContent()).toContain('Decisiones');
      expect(await decisionHud.locator('.ui-counter').textContent()).toBe('· 2');
      await page.getByRole('tab', { name: 'Decisiones', selected: true }).waitFor();
      if (width !== 390) {
        await decisionHud.click();
        expect(await windowPanel.count()).toBe(1);
      }
      const prStatus = page.getByTestId('dock-pr-status');
      expect(await prStatus.textContent()).toContain('Estado: PR');
      expect(await prStatus.getAttribute('aria-label')).toContain('Estado de PR:');
      if (width === 390) await page.keyboard.press('Escape');
      await prStatus.click();
      await page.getByRole('tab', { name: 'Backlog', selected: true }).waitFor();
      if (width !== 390) {
        await prStatus.click();
        expect(await windowPanel.count()).toBe(1);
      }
      await page.evaluate(`window.postMessage(${JSON.stringify(board)}, '*')`);
      await page.keyboard.press('Escape');
      // Selecting a character opens a separate accessible card at every viewport size.
      await canvas.focus();
      await page.evaluate(`
        window.postMessage({ type: 'agentCreated', id: 1, projectId: 'demo' }, '*');
        window.postMessage({ type: 'agentRole', id: 1, label: 'Developer', department: 'Ingeniería',
          characterDetail: { projectId: 'demo', taskKey: 'SA-119', taskTitle: 'long'.repeat(200), worktree: 'path/'.repeat(100) } }, '*');
      `);
      await page.waitForFunction(
        'window.__pixelAgentsTestHooks.getCharacters().some(character => character.id === 1)',
      );
      await page.evaluate('window.__pixelAgentsTestHooks.selectAgent(1)');
      const card = page.getByTestId('character-detail-panel');
      await card.waitFor();
      expect(await page.getByRole('tab', { name: 'Personaje' }).count()).toBe(0);
      expect(await windowPanel.count()).toBe(0);
      expect(await card.getAttribute('role')).toBe('dialog');
      expect(await card.evaluate(fitsHorizontally)).toBe(true);
      const cardBox = (await card.boundingBox())!;
      expect(cardBox.x).toBeGreaterThanOrEqual(0);
      expect(cardBox.y).toBeGreaterThanOrEqual(0);
      expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(width);
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(844);
      await card.getByRole('button', { name: 'Cerrar agente', exact: true }).click({ trial: true });
      await page.keyboard.press('Escape');
      await card.waitFor({ state: 'detached' });
      expect(await canvas.evaluate(isFocusedElement)).toBe(true);
      await page.evaluate('window.__pixelAgentsTestHooks.selectAgent(1)');
      await card.waitFor();
      await card.getByRole('button', { name: 'Ver en Backlog', exact: true }).click();
      await page.getByRole('tab', { name: 'Backlog', selected: true }).waitFor();
      expect(await card.count()).toBe(0);
      await page.keyboard.press('Escape');
      await page.evaluate('window.__pixelAgentsTestHooks.selectAgent(null)');
      // Let the real projection report deselection before remount/persistence assertions.
      await page.waitForTimeout(50);
      if (width === 390) {
        await backlog.tap();
        await page.getByRole('tab', { name: 'Features', exact: true }).tap();
        await page.getByRole('button', { name: 'Ver plan', exact: true }).tap();
        await page.getByRole('dialog', { name: 'Plan de feature', exact: true }).waitFor();
        await expectModalFocus(page, 'Plan de feature');
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
      await expectModalFocus(page, 'Plan de feature');
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
      await expectModalFocus(page, 'Nueva idea');
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
      // The clamp follows a ResizeObserver callback, so wait for it instead of racing it.
      await page.waitForFunction(
        "(document.querySelector('.panel-window-title')?.getBoundingClientRect().right ?? Infinity) <= 600",
      );
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

      // Synthetic pointer events isolate competing pointer IDs in the actual handlers.
      // Pointer capture requires a hardware down, so stub only that browser primitive.
      await title.evaluate((element) => {
        (element as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
      });
      const pointer = (pointerId: number, clientX: number, clientY: number) => ({
        pointerId,
        clientX,
        clientY,
        button: 0,
        bubbles: true,
      });
      await title.dispatchEvent('pointerdown', pointer(11, reset.x + 20, reset.y + 20));
      await title.dispatchEvent('pointerdown', pointer(22, reset.x + 30, reset.y + 30));
      await title.dispatchEvent('pointermove', pointer(22, reset.x + 90, reset.y + 90));
      expect(await windowPanel.boundingBox()).toEqual(reset);
      for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        await title.dispatchEvent(event, pointer(22, 0, 0));
      }
      await title.dispatchEvent('pointermove', pointer(11, reset.x + 36, reset.y + 36));
      const moved = (await windowPanel.boundingBox())!;
      expect(moved.x).toBe(reset.x + 16);
      expect(moved.y).toBe(reset.y + 16);
      await title.dispatchEvent('pointerup', pointer(11, 0, 0));
      await title.dispatchEvent('pointermove', pointer(11, reset.x + 80, reset.y + 80));
      expect(await windowPanel.boundingBox()).toEqual(moved);
      await title.dispatchEvent('pointerdown', pointer(33, moved.x + 20, moved.y + 20));
      await title.dispatchEvent('pointercancel', pointer(33, 0, 0));
      await title.dispatchEvent('pointermove', pointer(33, moved.x + 80, moved.y + 80));
      expect(await windowPanel.boundingBox()).toEqual(moved);

      for (const edge of ['w', 'n']) {
        await page.getByRole('button', { name: 'Restablecer posición', exact: true }).click();
        const beforeResize = (await windowPanel.boundingBox())!;
        const handle = page.locator(`.panel-window-resize-${edge}`);
        await handle.evaluate((element) => {
          (element as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
        });
        await handle.dispatchEvent('pointerdown', pointer(44, 100, 100));
        await handle.dispatchEvent('pointermove', pointer(44, 2100, 2100));
        await handle.dispatchEvent('pointerup', pointer(44, 2100, 2100));
        const afterResize = (await windowPanel.boundingBox())!;
        expect(afterResize.x + afterResize.width).toBe(beforeResize.x + beforeResize.width);
        expect(afterResize.y + afterResize.height).toBe(beforeResize.y + beforeResize.height);
        expect(edge === 'w' ? afterResize.width : afterResize.height).toBe(
          edge === 'w' ? PANEL_WINDOW_MIN_WIDTH_PX : PANEL_WINDOW_MIN_HEIGHT_PX,
        );
      }
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

    const focusPage = await browser.newPage();
    await focusPage.route('**/*', (route) =>
      route.request().isNavigationRequest()
        ? route.fulfill({
            contentType: 'text/html',
            body: html + '<button id="probe-opener">Open</button>',
          })
        : route.abort(),
    );
    await focusPage.goto('http://office-window.test/');
    await focusPage.addScriptTag({ content: script });
    await boot(focusPage);
    await focusPage.locator('#probe-opener').focus();
    await focusPage.evaluate("window.showFocusProbe('idea')");
    await expectModalFocus(focusPage, 'Nueva idea');
    // Close one modal and open another in a single commit. Its connected opener
    // must not steal focus back after the new modal's layout effect focuses it.
    await focusPage.evaluate("window.showFocusProbe('plan')");
    await expectModalFocus(focusPage, 'Plan de feature');
    await focusPage.getByRole('dialog', { name: 'Plan de feature', exact: true }).focus();
    await focusPage.evaluate('window.showStackedFocusProbe()');
    await expectModalFocus(focusPage, 'Nueva idea');
    await focusPage.evaluate('window.closeStackedFocusProbe()');
    await focusPage.evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
    // The queued restore from Nueva idea must preserve deliberate focus inside
    // the surviving plan, rather than returning to that dialog's root.
    expect(
      await focusPage
        .getByRole('button', { name: 'Cerrar', exact: true })
        .evaluate(isFocusedElement),
    ).toBe(true);
    await expectModalFocus(focusPage, 'Plan de feature');
    await focusPage.close();
  } finally {
    await browser.close();
  }
}, 120_000);
