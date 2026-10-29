import { fork } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { DesignValidation } from '../../core/src/designReport.js';
import { DESIGN_CANVAS_READY_TIMEOUT_MS } from './constants.js';

/** A mounted canvas alone may still be blank before its first animation frame. */
export async function waitForDesignCanvas(page: {
  locator: (selector: string) => { waitFor: (options: { timeout: number }) => Promise<unknown> };
}): Promise<void> {
  try {
    await page
      .locator('canvas[data-ready="true"]')
      .waitFor({ timeout: DESIGN_CANVAS_READY_TIMEOUT_MS });
  } catch {
    throw new Error(
      'Design capture infrastructure: invalid capture; office canvas was not ready before timeout',
    );
  }
}

export const DESIGN_VIEWS = ['office', 'features', 'audit', 'backlog', 'hud'] as const;
export type DesignView = (typeof DESIGN_VIEWS)[number];
export interface DesignEvidence {
  images: string[];
  validations: DesignValidation[];
}
export interface CaptureInput {
  tree: string;
  directory: string;
  views: DesignView[];
}
export const DESIGN_CAPTURE_TIMEOUT_MS = 120_000;
const CAPTURE_SHUTDOWN_GRACE_MS = 10_000;

/** Separate process: imports and all profile-dependent state see only the private HOME. */
export async function captureDesign(input: CaptureInput): Promise<DesignEvidence> {
  const home = path.join(input.directory, 'home');
  fs.mkdirSync(home, { recursive: true });
  const bundled = path.join(input.tree, 'dist', 'cli.js');
  if (!fs.existsSync(bundled))
    throw new Error('Design capture infrastructure: build the task tree CLI first');
  const child = fork(bundled, ['--design-capture-host'], {
    cwd: input.tree,
    execArgv: [],
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: home,
      USERPROFILE: home,
      APPDATA: home,
      LOCALAPPDATA: home,
      TEMP: home,
      TMP: home,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  return new Promise((resolve, reject) => {
    let result: DesignEvidence | undefined;
    let failure: Error | undefined;
    let shutdown: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      failure = new Error('Design capture infrastructure timeout');
      if (child.connected) child.send({ cancel: true });
      shutdown = setTimeout(() => child.kill(), CAPTURE_SHUTDOWN_GRACE_MS);
    }, DESIGN_CAPTURE_TIMEOUT_MS);
    child.on('error', (error) => {
      failure = error;
    });
    child.on('message', (message) => {
      const value = message as { evidence?: DesignEvidence; error?: string };
      if (value.error) failure = new Error(value.error);
      else result = value.evidence;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(shutdown);
      if (failure || code !== 0 || !result)
        reject(failure ?? new Error('Design capture infrastructure failed'));
      else resolve(result);
    });
    child.send(input);
  });
}
