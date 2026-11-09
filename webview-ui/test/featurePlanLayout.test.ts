import path from 'node:path';

import { chromium } from '@playwright/test';
import { build as bundle } from 'esbuild';
import { build } from 'vite';
import { expect, it } from 'vitest';

import viteConfig from '../vite.config.ts';
import { planSnapshot } from './fixtures/featurePlan.js';

it('keeps the plan decision visible at 761px with closed technical details and a bounded summary', async (context) => {
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
      cacheDir: path.resolve('../.vitest-tmp/feature-plan-vite'),
      logLevel: 'silent',
      build: { write: false },
    });
    const css = (Array.isArray(result) ? result : [result])
      .flatMap((output) => ('output' in output ? output.output : []))
      .filter((entry) => entry.type === 'asset' && entry.fileName.endsWith('.css'))
      .map((entry) => (entry.type === 'asset' ? String(entry.source) : ''))
      .join('\n');
    const response = planSnapshot('r');
    // A long literal document must affect only the disclosure's scrolling content.
    response.plan!.sections[0].content += '\nrule: literal\n'.repeat(1000);
    const bundled = await bundle({
      stdin: {
        resolveDir: path.resolve('src'),
        loader: 'tsx',
        contents: `
          import { createRoot } from 'react-dom/client';
          import { FeaturePlanView } from './components/FeaturePlanDialog';
          createRoot(document.getElementById('root')).render(<FeaturePlanView
            featureKey="FEAT-001" view={${JSON.stringify({ snapshot: response, pending: false, loading: false, notice: '' })}}
            onClose={() => {}} onApprove={() => {}} onRefresh={() => {}} />);
        `,
      },
      plugins: [
        {
          name: 'isolated-plan-transport',
          setup(build) {
            build.onLoad({ filter: /[\\/]transport[\\/]index\.ts$/ }, () => ({
              loader: 'js',
              contents: 'export const transport = {};',
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
    for (const width of [1024, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 761 } });
      await page.route('**/*', (route) => route.abort());
      await page.setContent(`<style>${css}</style><div id="root"></div>`);
      await page.addScriptTag({ content: bundled.outputFiles[0].text });
      const approve = page.getByRole('button', { name: 'Aprobar plan', exact: true });
      await approve.waitFor();
      const assertDecisionVisible = async () => {
        const box = (await approve.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(761);
        const warning = await page.getByText(/Este plan no incluye pruebas/).boundingBox();
        expect(warning!.y).toBeGreaterThanOrEqual(0);
        expect(warning!.y + warning!.height).toBeLessThanOrEqual(761);
      };
      await assertDecisionVisible();
      expect(await page.locator('details[open]').count()).toBe(0);
      expect(await page.locator('pre').isVisible()).toBe(false);
      expect(await page.locator('img').count()).toBe(0);
      expect(await page.locator('script').count()).toBe(1); // Injected test script only.
      const summary = page
        .getByRole('region', { name: 'Plan de FEAT-001' })
        .locator('section')
        .first();
      if (width === 1024) {
        const summaryBox = (await summary.boundingBox())!;
        const scrollBox = (await page.locator('.feature-plan-scroll').boundingBox())!;
        expect(summaryBox.y + summaryBox.height).toBeLessThanOrEqual(
          scrollBox.y + scrollBox.height,
        );
      }
      await page.locator('summary').first().click();
      expect(await page.locator('pre').isVisible()).toBe(true);
      await page
        .locator('.feature-plan-scroll')
        .evaluate('(element) => element.scrollTop = element.scrollHeight');
      await assertDecisionVisible();
      expect(await page.getByText('Depende de Crear resumen', { exact: true }).count()).toBe(1);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
