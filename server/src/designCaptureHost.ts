import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { Browser } from '@playwright/test';
import Fastify from 'fastify';
import * as fs from 'fs';
import * as path from 'path';

import type { DesignValidation } from '../../core/src/designReport.js';
import type { BoardState, FeatureRow } from '../../core/src/messages.js';
import { buildAssetCache } from './assetReload.js';
import type { CaptureInput, DesignEvidence } from './designCapture.js';
import { waitForDesignCanvas } from './designCapture.js';
import { contrastRatio } from './designer.js';

const VIEW_LABELS = {
  features: 'Features',
  audit: 'Auditoría',
  backlog: 'Backlog',
};
const VIEWPORTS = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];
const CAPTURE_WAIT_MS = 15_000;

/** Demo protocol fixture serves the task tree's real built SPA. No operator handlers,
 * watchers, executors, discovery, hooks, secrets or production WorkStore are reachable. */
export async function captureInHost(
  input: CaptureInput,
  signal?: AbortSignal,
): Promise<DesignEvidence> {
  const staticDir = path.join(input.tree, 'dist', 'webview');
  if (!fs.existsSync(path.join(staticDir, 'index.html')))
    throw new Error('Design capture infrastructure: build the task tree webview first');
  const cache = await buildAssetCache(path.join(input.tree, 'dist'), []);
  const app = Fastify({ logger: false });
  let browser: Browser | undefined;
  const cancel = () => {
    void browser?.close();
    void app.close();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  let state: 'empty' | 'error' | 'populated' = 'empty';
  const featureFixture: FeatureRow = {
    key: 'FEAT-105',
    title: 'Dirección artística del espacio de trabajo',
    state: 'in_development',
    rawStatus: 'approved',
    progress: { done: 2, total: 5 },
    currentTask: { key: 'FEAT-105-T03', step: 'develop', others: 1 },
    gates: [],
    integration: { branch: 'sa/FEAT-105-integration', sha: null },
    lastActivityAt: '2026-10-29T12:00:00Z',
    cost: {
      executions: 3,
      costKnown: 0,
      costUsd: null,
      costPerDoneTaskUsd: null,
      cacheHitRate: null,
    },
  };
  const validations: DesignValidation[] = [];
  const images: string[] = [];
  try {
    await app.register(fastifyStatic, { root: staticDir });
    await app.register(fastifyWebsocket);
    app.get('/ws', { websocket: true }, (socket) => {
      const send = (data: unknown) => socket.send(JSON.stringify(data));
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          type: string;
          projectId?: string;
          requestId?: string;
        };
        if (msg.type === 'webviewReady') {
          if (cache.characters)
            send({ type: 'characterSpritesLoaded', characters: cache.characters.characters });
          if (cache.floorTiles) send({ type: 'floorTilesLoaded', sprites: cache.floorTiles });
          if (cache.wallTiles) send({ type: 'wallTilesLoaded', sets: cache.wallTiles });
          if (cache.furniture)
            send({
              type: 'furnitureAssetsLoaded',
              catalog: cache.furniture.catalog,
              sprites: Object.fromEntries(cache.furniture.sprites),
            });
          send({
            type: 'settingsLoaded',
            soundEnabled: false,
            lastSeenVersion: 'demo',
            extensionVersion: 'demo',
            hooksEnabled: false,
            hooksInfoShown: true,
          });
          send({
            type: 'existingAgents',
            agents: [],
            agentMeta: {},
            folderNames: {},
            externalAgents: [],
          });
          send({ type: 'layoutLoaded', layout: cache.defaultLayout });
          send({
            type: 'executorState',
            projectId: 'design-demo',
            revision: 'demo',
            sequence: 1,
            observedAt: Date.now(),
            canManage: false,
            configurationStatus: 'ready',
            executors: [],
          });
          const quota = (provider: 'claude' | 'codex') => ({
            provider,
            status: 'unknown' as const,
            usedPercent: null,
            resetsAt: null,
            observedAt: null,
          });
          send({
            type: 'boardState',
            mode: 'project',
            project: 'Design demo',
            projectId: 'design-demo',
            items:
              state === 'populated'
                ? [
                    {
                      id: 'FEAT-105-T03',
                      title: 'Implementar estados de foco y navegación',
                      phase: 'implementing',
                      agentIds: [],
                      size: 'M',
                    },
                  ]
                : [],
            recent: [],
            sources: { board: true, claims: true, progress: true },
            quota: { claude: quota('claude'), codex: quota('codex') },
            gate: [],
            summary: { total: state === 'populated' ? 1 : 0, byPhase: {}, byEpic: {} },
            waiting: [],
            decisions: [],
            generatedAt: Date.now(),
          } satisfies BoardState);
        } else if (msg.type === 'requestFeatures') {
          send({
            type: 'featuresSnapshot',
            projectId: msg.projectId,
            requestId: msg.requestId,
            status: state === 'error' ? 'read_error' : state === 'populated' ? 'ok' : 'empty',
            reason: state === 'error' ? 'query_failed' : null,
            features: state === 'populated' ? [featureFixture] : [],
          });
        } else if (msg.type === 'requestAuditLog') {
          send({
            type: 'auditLog',
            projectId: msg.projectId,
            requestId: msg.requestId,
            status: state === 'error' ? 'read_error' : 'empty',
            entries: [],
            totalValid: 0,
            truncated: false,
            corruptLines: [],
            excludedCount: 0,
          });
        }
      });
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing capture server address');
    try {
      // Optional existing operator tooling; do not bundle Playwright's package-relative assets.
      const packageName = '@playwright/test';
      const { chromium } = require(packageName) as typeof import('@playwright/test');
      browser = await chromium.launch({ headless: true, timeout: CAPTURE_WAIT_MS });
    } catch {
      throw new Error(
        'Design capture infrastructure: Playwright Chromium unavailable; install browsers outside this command and set PLAYWRIGHT_BROWSERS_PATH',
      );
    }
    for (const viewport of VIEWPORTS)
      for (const view of input.views) {
        if (signal?.aborted) throw new Error('Design capture infrastructure: interrupted');
        for (const fixture of view === 'features' || view === 'audit'
          ? view === 'features'
            ? (['empty', 'error', 'populated'] as const)
            : (['empty', 'error'] as const)
          : view === 'backlog'
            ? (['empty', 'populated'] as const)
            : (['empty'] as const)) {
          state = fixture;
          const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
          try {
            const page = await context.newPage();
            // No network outside this isolated server; assets and fixture are local.
            await page.route('**/*', (route) =>
              new URL(route.request().url()).origin === `http://127.0.0.1:${address.port}`
                ? route.continue()
                : route.abort(),
            );
            await page.goto(`http://127.0.0.1:${address.port}`, { timeout: CAPTURE_WAIT_MS });
            await waitForDesignCanvas(page);
            await page.getByTestId('company-hud').waitFor({ timeout: CAPTURE_WAIT_MS });
            const openSection = async () => {
              if (!(view in VIEW_LABELS)) return;
              // All sections now live in one window. Open it through its dock entry,
              // then navigate using the same tabs as the operator.
              await page.getByRole('button', { name: 'Backlog', exact: true }).click();
              const window = page.getByTestId('panel-window');
              await window.waitFor({ timeout: CAPTURE_WAIT_MS });
              await page
                .getByRole('tab', {
                  name: VIEW_LABELS[view as keyof typeof VIEW_LABELS],
                  exact: true,
                })
                .click();
              const panel = window.getByTestId(`${view}-panel`);
              await panel.waitFor({ timeout: CAPTURE_WAIT_MS });
              if (fixture === 'populated')
                await (
                  view === 'features'
                    ? panel.getByTitle(featureFixture.title!, { exact: true })
                    : panel.getByText('FEAT-105-T03', { exact: true })
                ).waitFor({ timeout: CAPTURE_WAIT_MS });
              if (view === 'features' && fixture !== 'populated')
                await panel
                  .getByText(fixture === 'error' ? /No se|Error|error|consulta/ : 'sin features')
                  .first()
                  .waitFor({ timeout: CAPTURE_WAIT_MS });
              if (view === 'audit')
                await panel
                  .getByText(
                    fixture === 'error' ? /No se|Error|error/ : 'Aún no hay nada registrado.',
                  )
                  .first()
                  .waitFor({ timeout: CAPTURE_WAIT_MS });
            };
            await openSection();
            const id = `${view}-${viewport.width}-${fixture}`;
            const png = path.join(input.directory, `${id}.png`);
            await page.screenshot({ path: png, fullPage: true, animations: 'disabled' });
            images.push(png);
            validations.push({
              kind: 'capture',
              tool: 'playwright/v1',
              result: 'pass',
              evidence: `${id}.png (demo fixture: ${fixture})`,
            });
            const toolbarButton = page.getByRole('button', {
              name: VIEW_LABELS.features,
              exact: true,
            });
            const panelButton = page.locator('[role="region"] button:enabled').first();
            // On mobile the window is a full-screen sheet. Exercise the real dock
            // before reopening the section for panel interactions and contrast.
            const restoreWindow = viewport.width === 390 && view in VIEW_LABELS;
            if (restoreWindow)
              await page.getByRole('button', { name: 'Cerrar ventana', exact: true }).click();
            for (const [scope, button] of [
              ['toolbar', toolbarButton],
              ['panel', panelButton],
            ] as const) {
              if (scope === 'panel' && restoreWindow) await openSection();
              if (!(await button.count()) || !(await button.isVisible())) {
                validations.push({
                  kind: 'interaction',
                  tool: 'playwright/v1',
                  result: 'not_tested',
                  evidence: `${id}: ${scope} hover/focus-visible unavailable`,
                });
                continue;
              }
              for (const interaction of ['hover', 'focus-visible'] as const) {
                await page.mouse.move(0, 0);
                if (interaction === 'hover') await button.hover();
                else {
                  await page.keyboard.press('Tab');
                  await button.focus();
                }
                const verified = await button.evaluate(
                  (el, pseudo) =>
                    (el as unknown as { matches(selector: string): boolean }).matches(`:${pseudo}`),
                  interaction,
                );
                if (!verified) {
                  validations.push({
                    kind: 'interaction',
                    tool: 'playwright/v1',
                    result: 'not_tested',
                    evidence: `${id}: ${scope} ${interaction} did not activate`,
                  });
                  continue;
                }
                const file = `${id}-${scope}-${interaction}.png`;
                await page.screenshot({
                  path: path.join(input.directory, file),
                  fullPage: true,
                  animations: 'disabled',
                });
                images.push(path.join(input.directory, file));
                validations.push({
                  kind: 'interaction',
                  tool: 'playwright/v1',
                  result: 'pass',
                  evidence: `${file}; pseudo-state verified; interaction contrast not verified`,
                });
              }
            }
            await page.mouse.move(0, 0);
            await page.evaluate('document.activeElement?.blur?.()');
            // eslint-disable-next-line pixel-agents/no-inline-colors -- Matches computed transparent backgrounds; does not style UI.
            const pairs = (await page.evaluate(`(() => {
            const rows = [];
            for (const el of document.querySelectorAll('body *')) {
              if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
              const r = el.getBoundingClientRect(), s = getComputedStyle(el);
              if (!r.width || !r.height || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth || s.visibility !== 'visible' || s.display === 'none') continue;
              const rgb = value => { const m = /^rgba?\\(([^)]+)\\)$/.exec(value); if (!m) return null; const v = m[1].split(',').map(Number); return v.length === 3 || v[3] === 1 ? v.slice(0,3) : null; };
              let bg = null, unsupported = false;
              for (let node = el; node; node = node.parentElement) {
                const c = getComputedStyle(node);
                if (Number(c.opacity) !== 1 || c.backgroundImage !== 'none' || c.filter !== 'none' || c.mixBlendMode !== 'normal') unsupported = true;
                if (!bg && c.backgroundColor !== 'rgba(0, 0, 0, 0)') { bg = rgb(c.backgroundColor); if (!bg) unsupported = true; }
              }
              rows.push({ tag: el.tagName, fg: rgb(s.color), bg, unsupported, large: parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.6667 && Number(s.fontWeight) >= 700) });
            }
            return rows;
          })()`)) as {
              tag: string;
              fg: number[] | null;
              bg: number[] | null;
              unsupported: boolean;
              large: boolean;
            }[];
            const contrasts = pairs.map((p, index) => ({
              element: `${p.tag}:${index}`,
              ratio: p.fg && p.bg && !p.unsupported ? contrastRatio(p.fg, p.bg) : null,
              threshold: p.large ? 3 : 4.5,
            }));
            const evidenceFile = `${id}-contrast.json`;
            fs.writeFileSync(
              path.join(input.directory, evidenceFile),
              JSON.stringify(contrasts, null, 2),
            );
            validations.push({
              kind: 'contrast',
              tool: 'playwright-wcag/v1',
              result: contrasts.some((p) => p.ratio !== null && p.ratio < p.threshold)
                ? 'fail'
                : contrasts.length && contrasts.every((p) => p.ratio !== null)
                  ? 'pass'
                  : 'not_tested',
              evidence: `${evidenceFile}; computed visible DOM text only; canvas, image/gradient, transparency, occlusion and non-text contrast not verified`,
            });
          } finally {
            await context.close();
          }
        }
      }
    return { images, validations };
  } finally {
    signal?.removeEventListener('abort', cancel);
    try {
      await browser?.close();
    } finally {
      await app.close();
    }
  }
}

export function designCaptureHost(): void {
  process.once('message', (input) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('disconnect', abort);
    process.once('message', abort);
    void captureInHost(input as CaptureInput, controller.signal)
      .then(
        (evidence) => {
          process.send?.({ evidence }, () => process.disconnect?.());
        },
        (error) => {
          const message =
            error instanceof Error && error.message.startsWith('Design capture infrastructure:')
              ? error.message
              : 'Design capture infrastructure failed (fixture navigation); no review was approved';
          process.send?.({ error: message }, () => {
            process.exitCode = 1;
            process.disconnect?.();
          });
        },
      )
      .finally(() => {
        process.removeListener('disconnect', abort);
        process.removeListener('message', abort);
      });
  });
}
