import path from 'node:path';

import { chromium, expect as browserExpect } from '@playwright/test';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('welcomes empty offices, reuses Nueva idea, dismisses, hides after work, and describes zero work', async (context) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    context.skip(true, 'Playwright Chromium unavailable in sandbox');
    return;
  }
  try {
    const bundled = await build({
      stdin: {
        resolveDir: path.resolve('src'),
        loader: 'tsx',
        contents: `
        import { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { OfficeEmptyState } from './components/OfficeEmptyState';
        import { CompanyHud } from './components/CompanyHud';
        import { setBoardState } from './office/boardStore';
        import { setFeaturesStore } from './office/featuresStore';
        import { emptyBoard, emptyFeatures } from '../test/fixtures/officeStart';
        window.setStartBoard = (overrides) => setBoardState(emptyBoard(overrides));
        window.setStartFeatures = (overrides) => setFeaturesStore(emptyFeatures(overrides));
        window.setStartBoard({});
        const officeState = { characters: new Map() };
        function Harness() {
          const [idea, setIdea] = useState(false);
          const [sessions, setSessions] = useState([]);
          window.setStartSessions = setSessions;
          const newIdea = () => setIdea(true);
          return <>
            <CompanyHud agents={sessions} officeState={officeState} onOpenDecisions={() => {}} onOpenMeeting={() => {}} />
            <OfficeEmptyState agents={[]} onNewIdea={newIdea} />
            <nav><button onClick={newIdea}>Nueva idea</button></nav>
            {idea && <div role="dialog" aria-label="Nueva idea">Nueva idea</div>}
          </>;
        }
        const root = createRoot(document.getElementById('root'));
        root.render(<Harness />);
      `,
      },
      plugins: [
        {
          name: 'isolated-transport',
          setup(build) {
            build.onLoad({ filter: /[\\/]transport[\\/]index\.ts$/ }, () => ({
              loader: 'js',
              contents: `export const transport = {
          state: 'connected', send() {}, onMessage: () => () => {}, onStateChange: () => () => {}
        };`,
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
    const page = await browser.newPage();
    const mount = async () => {
      await page.goto('about:blank');
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: bundled.outputFiles[0].text });
      await browserExpect(page.getByRole('region', { name: 'Empieza con una idea' })).toBeVisible();
    };
    await mount();
    const welcome = page.getByRole('region', { name: 'Empieza con una idea' });
    await browserExpect(welcome).toContainText('Coordina agentes de IA para construir software');
    await browserExpect(page.getByTestId('hud-pulse')).toHaveText(
      'Nadie trabajando · nada espera tu revisión',
    );
    await browserExpect(page.getByTestId('company-hud')).not.toContainText('Capacidad observada');
    await browserExpect(page.getByTestId('company-hud')).not.toContainText('Claude 0');
    // Open sessions are activity even when the board has no work yet.
    await page.evaluate('window.setStartSessions([1])');
    await browserExpect(page.getByTestId('hud-pulse')).toHaveText(
      '1 sesión abierta · nada espera tu revisión',
    );
    await page.evaluate('window.setStartSessions([])');
    await welcome.getByRole('button', { name: 'Nueva idea', exact: true }).click();
    await browserExpect(page.getByRole('dialog', { name: 'Nueva idea' })).toBeVisible();
    await welcome.getByRole('button', { name: 'Ocultar bienvenida' }).click();
    await browserExpect(welcome).toHaveCount(0);
    await page.evaluate('window.setStartBoard({})');
    await browserExpect(welcome).toHaveCount(0);

    await mount();
    await page.evaluate(`window.setStartBoard({
      sources: { board: true, claims: false, progress: false },
      items: [{ id: 'T-1', title: 'Revisar trabajo', phase: 'WAITING_HUMAN', agentIds: [] }]
    })`);
    await browserExpect(welcome).toHaveCount(0);
    await browserExpect(page.getByTestId('hud-pulse')).toHaveText(
      '0 trabajando · 1 te necesitan · 0 bloqueadas',
    );
    await page.evaluate('window.setStartBoard({})');
    await browserExpect(welcome).toHaveCount(0);

    await mount();
    await page.evaluate('window.setStartBoard({ projectId: "P", mode: "project" })');
    await browserExpect(welcome).toHaveCount(0);
    await page.evaluate('window.setStartFeatures({})');
    await browserExpect(welcome).toBeVisible();
    await browserExpect(page.getByTestId('hud-pulse')).toHaveText(
      'Nadie trabajando · nada espera tu revisión',
    );
    expect(await welcome.getByRole('button').count()).toBe(2);
  } finally {
    await browser.close();
  }
});
