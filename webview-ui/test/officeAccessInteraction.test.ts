import { readFileSync } from 'node:fs';
import path from 'node:path';

import { chromium } from '@playwright/test';
import { buildSync } from 'esbuild';
import { build } from 'vite';
import { expect, it } from 'vitest';

import viteConfig from '../vite.config.ts';

it('stacks access help and hooks notices at 390px and desktop, and isolates Escape from the editor', async (context) => {
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
      cacheDir: path.resolve('../.vitest-tmp/access-vite'),
      logLevel: 'silent',
      build: { write: false },
    });
    const css = (Array.isArray(result) ? result : [result])
      .flatMap((output) => ('output' in output ? output.output : []))
      .filter((entry) => entry.type === 'asset' && entry.fileName.endsWith('.css'))
      .map((entry) => (entry.type === 'asset' ? String(entry.source) : ''))
      .join('\n');
    // Bundle the real interactive components without adding TSX to tsconfig.node.
    const script = buildSync({
      stdin: {
        resolveDir: path.resolve('src'),
        loader: 'tsx',
        contents: `
          import { useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { OfficeNotices } from './components/OfficeNotices';
          import { Tooltip } from './components/Tooltip';
          import { setOfficeAccess } from './office/accessStore';
          import { useEditorKeyboard } from './hooks/useEditorKeyboard';
          import { EditorState } from './office/editor/editorState';
          setOfficeAccess({ type: 'officeAccess', privileged: true, reason: 'managed_process' });
          const editor = new EditorState();
          let escapes = 0;
          const record = () => document.body.dataset.editorEscapes = String(++escapes);
          const noop = () => {};
          function Harness() {
            const [notice, showNotice] = useState(true);
            useEditorKeyboard(true, editor, noop, noop, noop, noop, noop, record, record);
            return <>
              <button id="outside">Outside</button>
              <OfficeNotices>
                {notice && <Tooltip title="Instant Detection Active" position="stack" onDismiss={() => showNotice(false)}>
                  Your agents now respond in real-time. View more
                </Tooltip>}
              </OfficeNotices>
            </>;
          }
          const root = createRoot(document.getElementById('root'));
          window.unmountOfficeAccess = () => root.unmount();
          root.render(<Harness />);
        `,
      },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
    }).outputFiles[0].text;
    const font = readFileSync('public/fonts/FSPixelSansUnicode-Regular.ttf').toString('base64');
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.setContent(
        `<style>${css}\n@font-face { font-family: 'FS Pixel Sans'; src: url(data:font/ttf;base64,${font}); }</style><div id="root"></div>`,
      );
      await page.addScriptTag({ content: script });
      await page.evaluate('document.fonts.ready');
      const badge = page.getByRole('button', {
        name: 'Operador · proceso gestionado',
        exact: true,
      });
      const dismiss = page
        .locator('.office-notices')
        .getByRole('button', { name: 'x', exact: true });
      // Check both closed and expanded help. Hit testing must reach both buttons.
      for (const expanded of [false, true]) {
        if (expanded) await badge.click();
        const badgeBox = (await badge.boundingBox())!;
        const dismissBox = (await dismiss.boundingBox())!;
        expect(dismissBox.y).toBeGreaterThan(badgeBox.y + badgeBox.height);
        if (expanded) {
          const help = (await page.locator('#office-mode-explanation').boundingBox())!;
          expect(dismissBox.y).toBeGreaterThan(help.y + help.height);
        }
        for (const box of [badgeBox, dismissBox]) {
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
        }
        await badge.click({ trial: true });
        await dismiss.click({ trial: true });
      }
      // Move focus away so this also exercises global capture, not just button bubbling.
      await page.locator('#outside').focus();
      await page.keyboard.press('Escape');
      expect(await badge.getAttribute('aria-expanded')).toBe('false');
      expect(await page.locator('#office-mode-explanation').count()).toBe(0);
      expect(await page.evaluate("document.activeElement?.getAttribute('aria-controls')")).toBe(
        'office-mode-explanation',
      );
      expect(await page.locator('body').getAttribute('data-editor-escapes')).toBeNull();
      await page.keyboard.press('Escape');
      expect(await page.locator('body').getAttribute('data-editor-escapes')).toBe('1');
      await dismiss.click();
      expect(await page.getByText('Instant Detection Active').count()).toBe(0);
      await badge.click();
      expect(await page.locator('#office-mode-explanation').count()).toBe(1);
      await page.keyboard.press('Escape');
      expect(await badge.getAttribute('aria-expanded')).toBe('false');
      await page.evaluate('window.unmountOfficeAccess()');
    }
  } finally {
    await browser.close();
  }
});
