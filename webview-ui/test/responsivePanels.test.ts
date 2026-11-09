import { readFileSync } from 'node:fs';
import path from 'node:path';

import { chromium } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'vite';
import { expect, it, vi } from 'vitest';

import { setBoardState } from '../src/office/boardStore.js';
import { emptyExecutorStore, setExecutorStore } from '../src/office/executorStore.js';
import viteConfig from '../vite.config.ts';

vi.mock('../src/transport/index.js', () => ({
  transport: { state: 'connected', send: vi.fn(), onStateChange: () => () => {} },
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_: unknown, get: () => unknown) => get(),
}));

it('contains panels and all six navigation targets at 390px, with keyboard and touch access', async (context) => {
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
    const outputs = Array.isArray(result) ? result : [result];
    const css = outputs
      .flatMap((output) => ('output' in output ? output.output : []))
      .filter((entry) => entry.type === 'asset' && entry.fileName.endsWith('.css'))
      .map((entry) => (entry.type === 'asset' ? String(entry.source) : ''))
      .join('\n');
    const font = readFileSync('public/fonts/FSPixelSansUnicode-Regular.ttf').toString('base64');
    const toolbarPath = '../src/components/BottomToolbar.js';
    const featuresPath = '../src/components/FeaturesPanel.js';
    const auditPath = '../src/components/AuditPanel.js';
    const { BottomToolbar } = await import(toolbarPath);
    const { FeaturesPanel } = await import(featuresPath);
    const { AuditPanel } = await import(auditPath);
    const backlogPath = '../src/components/BacklogPanel.js';
    const { BacklogPanel } = await import(backlogPath);
    setExecutorStore(emptyExecutorStore());
    const noop = () => {};
    const toolbar = renderToStaticMarkup(
      createElement(BottomToolbar, {
        isEditMode: false,
        onOpenClaude: noop,
        onToggleEditMode: noop,
        isSettingsOpen: false,
        onToggleSettings: noop,
        isBacklogOpen: false,
        onToggleBacklog: noop,
        isAuditOpen: false,
        onToggleAudit: noop,
        isFeaturesOpen: false,
        onToggleFeatures: noop,
        workspaceFolders: [],
      }),
    );
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await page.route('**/*', (route) => route.abort());
    const detailPath = '../src/components/CharacterDetailPanel.js';
    const { CharacterDetailPanel } = await import(detailPath);
    const detailMarkup = renderToStaticMarkup(
      createElement(CharacterDetailPanel, {
        detail: { taskTitle: 'long'.repeat(200), worktree: 'path/'.repeat(100) } as never,
      }),
    );
    await page.setContent(
      `<style>${css}</style><div style="position:relative;width:100vw;height:100vh">${detailMarkup}</div>`,
    );
    const detailBox = (await page.getByRole('region').boundingBox())!;
    expect(detailBox.x).toBeGreaterThanOrEqual(0);
    expect(detailBox.x + detailBox.width).toBeLessThanOrEqual(390);
    expect(
      await page.evaluate(
        `(() => { const el = document.querySelector('[data-testid="character-detail-panel"]'); return el.scrollWidth <= el.clientWidth; })()`,
      ),
    ).toBe(true);
    const panels = [FeaturesPanel, AuditPanel].map((Panel) =>
      renderToStaticMarkup(createElement(Panel, { isOpen: true, onClose: noop })),
    );
    panels.push(
      renderToStaticMarkup(
        createElement(BacklogPanel, {
          isOpen: true,
          onClose: noop,
          onFocusAgent: noop,
          officeState: {} as never,
        }),
      ),
    );
    for (const markup of panels) {
      await page.setContent(
        `<style>${css}\n@font-face { font-family: 'FS Pixel Sans'; src: url(data:font/ttf;base64,${font}); }</style><div style="position:relative;width:100vw;height:100vh">${toolbar}<div class="office-panels"><div class="office-panel-hud"><div data-testid="company-hud" style="height:140px"><span class="ui-info">Manager: sin ronda activa</span><span class="ui-counter">0 de 0 hechas</span></div></div>${markup}</div></div>`,
      );
      await page.evaluate('document.fonts.ready');
      const panel = await page.getByRole('region').boundingBox();
      expect(panel!.x).toBeGreaterThanOrEqual(16);
      expect(panel!.x + panel!.width).toBeLessThanOrEqual(374);
      expect(panel!.y).toBe(240);
      await page.evaluate(
        "document.querySelector('[data-testid=company-hud]').style.height = '200px'",
      );
      expect((await page.getByRole('region').boundingBox())!.y).toBe(300);
      expect(
        await page.evaluate("getComputedStyle(document.querySelector('.ui-info')).fontSize"),
      ).toBe('24px');
      expect(
        await page.evaluate(
          "getComputedStyle(document.querySelector('.ui-counter')).fontVariantNumeric",
        ),
      ).toContain('slashed-zero');
      const closeBox = (await page
        .getByRole('button', { name: 'Cerrar', exact: true })
        .boundingBox())!;
      expect(Math.min(closeBox.width, closeBox.height)).toBeGreaterThanOrEqual(24);
      expect(
        await page.evaluate(
          `(() => { const el = document.querySelector('[role="region"]'); return el.scrollWidth <= el.clientWidth; })()`,
        ),
      ).toBe(true);
      const buttons = page.locator('.bottom-toolbar button');
      expect(await buttons.count()).toBe(7);
      const widths: number[] = [];
      for (let index = 0; index < 7; index++) {
        const button = buttons.nth(index);
        const box = (await button.boundingBox())!;
        widths.push(box.width);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(390);
        expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24);
        await page.keyboard.press('Tab');
        expect(await page.evaluate('document.activeElement.textContent')).toBe(
          await button.textContent(),
        );
      }
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
      await page.getByRole('button', { name: 'Settings', exact: true }).tap();
      for (const name of markup.includes('features-panel')
        ? ['Cerrar', 'Actualizar']
        : ['Cerrar']) {
        const box = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(16);
        expect(box.x + box.width).toBeLessThanOrEqual(374);
      }
    }
    // Exercise the real HUD: the old stub missed Tailwind's independent translate.
    const hudPath = '../src/components/CompanyHud.js';
    const zoomPath = '../src/components/ZoomControls.js';
    const { CompanyHud } = await import(hudPath);
    const { ZoomControls } = await import(zoomPath);
    setBoardState({
      project: 'Design demo with a very long project title',
      items: [],
      sources: { board: true },
      summary: { total: 123, byPhase: { DONE: 12 } },
    } as never);
    const hud = renderToStaticMarkup(
      createElement(CompanyHud, {
        onOpenDecisions: noop,
        onOpenBacklog: noop,
        officeState: {} as never,
        agents: [],
      }),
    );
    const zoom = renderToStaticMarkup(createElement(ZoomControls, { zoom: 2, onZoomChange: noop }));
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.setContent(
        `<style>${css}</style><div style="position:relative;width:100vw;height:100vh">${zoom}<div class="office-panels"><div class="office-panel-hud">${hud}</div>${panels[0]}</div></div>`,
      );
      const card = page.getByTestId('company-hud');
      const box = (await card.boundingBox())!;
      const panel = (await page.getByRole('region').boundingBox())!;
      expect(box.x).toBe(panel.x);
      expect(box.x).toBeGreaterThanOrEqual(16);
      expect(box.x + box.width).toBeLessThanOrEqual(width - 16);
      expect(panel.y).toBeGreaterThan(box.y + box.height);
      expect(await card.locator('.ui-counter').textContent()).toBe('12 de 123 hechas');
      expect(
        await page.evaluate(
          "(() => { const el = document.querySelector('[data-testid=company-hud]'); return el.scrollWidth <= el.clientWidth; })()",
        ),
      ).toBe(true);
      const zoomBox = (await page.getByTitle('Ampliar (Ctrl + rueda)').boundingBox())!;
      expect(zoomBox.y + zoomBox.height <= box.y || zoomBox.x + zoomBox.width <= box.x).toBe(true);
      expect(await page.getByRole('heading', { name: 'Features solo lectura' }).count()).toBe(1);
    }
  } finally {
    await browser.close();
  }
});
