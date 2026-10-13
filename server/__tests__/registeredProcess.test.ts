import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { spawnRegisteredProcess } from '../src/executors/registeredProcess.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registered-process-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Resolves with the events seen once 'close' arrives; rejects if it never does. */
function settle(child: ChildProcess, timeoutMs = 5000) {
  const seen: string[] = [];
  child.stdout!.resume();
  child.stderr!.resume();
  child.on('error', () => seen.push('error'));
  child.on('exit', () => seen.push('exit'));
  return new Promise<{ seen: string[]; code: number | null }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no 'close' within ${timeoutMs} ms (saw: ${seen.join(', ')})`)),
      timeoutMs,
    );
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ seen, code });
    });
  });
}

const marker = () => path.join(dir, 'launched');
const command = () => ['-e', `require('fs').writeFileSync(${JSON.stringify(marker())}, 'x')`];

it('a failed registration still closes, so executors release their slot and lock', async () => {
  const child = spawnRegisteredProcess(process.execPath, command(), dir, () => {
    throw new Error('Cannot verify launch process');
  });
  const { seen } = await settle(child);
  expect(seen).toContain('error');
  expect(seen).toContain('exit');
  // Nothing was ACKed, so the CLI never ran.
  expect(fs.existsSync(marker())).toBe(false);
});

it('a registered process launches the CLI and closes with its exit code', async () => {
  let registered: number | undefined;
  const child = spawnRegisteredProcess(process.execPath, command(), dir, (pid) => {
    registered = pid;
  });
  const { seen, code } = await settle(child);
  expect(registered).toBe(child.pid);
  expect(seen).not.toContain('error');
  expect(code).toBe(0);
  expect(fs.existsSync(marker())).toBe(true);
});
