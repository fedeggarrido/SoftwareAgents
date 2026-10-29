import { readFileSync } from 'node:fs';
import path from 'node:path';

import { chromium } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'vite';
import { expect, it, vi } from 'vitest';

import { emptyExecutorStore, setExecutorStore } from '../src/office/executorStore.js';
import viteConfig from '../vite.config.ts';

vi.mock('../src/transport/index.js', () => ({
  transport: { state: 'connected', send: vi.fn(), onStateChange: () => () => {} },
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_: unknown, get: () => unknown) => get(),
}));

it('contains panels and all five navigation targets at 390px, with keyboard and touch access', async (context) => {
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
    for (const Panel of [FeaturesPanel, AuditPanel]) {
      await page.setContent(
        `<style>${css}\n@font-face { font-family: 'FS Pixel Sans'; src: url(data:font/ttf;base64,${font}); }</style><div style="position:relative;width:100vw;height:100vh">${toolbar}${renderToStaticMarkup(createElement(Panel, { isOpen: true, onClose: noop }))}</div>`,
      );
      await page.evaluate('document.fonts.ready');
      const panel = await page.getByRole('region').boundingBox();
      expect(panel!.x).toBeGreaterThanOrEqual(16);
      expect(panel!.x + panel!.width).toBeLessThanOrEqual(374);
      expect(
        await page.evaluate(
          `(() => { const el = document.querySelector('[role="region"]'); return el.scrollWidth <= el.clientWidth; })()`,
        ),
      ).toBe(true);
      const buttons = page.locator('.bottom-toolbar > button');
      expect(await buttons.count()).toBe(5);
      const widths: number[] = [];
      for (let index = 0; index < 5; index++) {
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
      for (const name of Panel === FeaturesPanel ? ['Cerrar', 'Actualizar'] : []) {
        const box = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(16);
        expect(box.x + box.width).toBeLessThanOrEqual(374);
      }
    }
  } finally {
    await browser.close();
  }
});
