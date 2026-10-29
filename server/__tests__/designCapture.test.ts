import { chromium } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expect, it } from 'vitest';

import { captureDesign } from '../src/designCapture.js';

it('captures real standalone SPA desktop/mobile panels and fixture states with runtime contrast', async (context) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    context.skip(
      true,
      'Playwright Chromium unavailable in sandbox; run outside with PLAYWRIGHT_BROWSERS_PATH',
    );
    return;
  }
  await browser.close();
  const tree = path.resolve('..');
  expect(
    fs.existsSync(path.join(tree, 'dist/webview/index.html')),
    'Build task tree webview before runtime capture test',
  ).toBe(true);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'design-capture-'));
  try {
    const evidence = await captureDesign({
      tree,
      directory,
      views: ['office', 'features', 'audit', 'backlog', 'hud'],
    });
    expect(evidence.images).toHaveLength(14);
    for (const png of evidence.images)
      expect(fs.readFileSync(png).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(evidence.validations.filter((v) => v.kind === 'contrast')).toHaveLength(14);
    for (const validation of evidence.validations.filter((v) => v.kind === 'contrast')) {
      const rows = JSON.parse(
        fs.readFileSync(path.join(directory, validation.evidence.split(';')[0]), 'utf8'),
      ) as Array<{ element: string; ratio: number | null; threshold: number }>;
      expect(
        rows.filter((row) => row.ratio !== null && row.ratio < row.threshold),
        validation.evidence,
      ).toEqual([]);
    }
    expect(JSON.stringify(evidence)).not.toContain('token=');
    const rows = JSON.parse(
      fs.readFileSync(path.join(directory, 'features-1440-empty-contrast.json'), 'utf8'),
    );
    expect(rows.some((row: { ratio: number | null }) => row.ratio !== null)).toBe(true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
