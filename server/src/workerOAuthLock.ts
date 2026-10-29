import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  CLAUDE_OAUTH_REFRESH_LOCK_FILE_NAME,
  CLAUDE_OAUTH_REFRESH_LOCK_MAX_BYTES,
  EXECUTOR_PROBE_TIMEOUT_MS,
} from './constants.js';
import { slotProcessIdentity } from './executorSlots.js';

/** Conservative absence check. Unknown process visibility never proves absence. */
export function noClaudeProcess(): boolean {
  try {
    if (process.platform === 'win32') {
      const count = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter "(Name = 'claude.exe' OR Name = 'node.exe') AND ProcessId <> ${process.pid}").Count`,
        ],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: EXECUTOR_PROBE_TIMEOUT_MS,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ).trim();
      return count === '0';
    }
    if (process.platform !== 'linux') return false;
    for (const pid of fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
      try {
        const command = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
        if (Number(pid) !== process.pid && /^(claude|node|nodejs)$/i.test(command)) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Require a regular, PID-bearing lock and a demonstrably dead owner.
 * Unknown formats, links, live/reused PIDs and failed probes retain the lock. */
export function clearWorkerOAuthLock(
  configDir: string | undefined,
  audit: () => void,
  absent = noClaudeProcess,
  identity = slotProcessIdentity,
): boolean {
  if (!configDir) return false;
  const lock = path.join(configDir, CLAUDE_OAUTH_REFRESH_LOCK_FILE_NAME);
  try {
    if (fs.lstatSync(configDir).isSymbolicLink()) return false;
    const normalize = (file: string) => (process.platform === 'win32' ? file.toLowerCase() : file);
    if (normalize(fs.realpathSync.native(configDir)) !== normalize(path.resolve(configDir)))
      return false;
    const before = fs.lstatSync(lock);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > CLAUDE_OAUTH_REFRESH_LOCK_MAX_BYTES
    )
      return false;
    const content = fs.readFileSync(lock, 'utf8');
    const value: unknown = JSON.parse(content);
    const pid = typeof value === 'number' ? value : (value as { pid?: unknown } | null)?.pid;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
    if (identity(pid) !== null || !absent()) return false;
    const after = fs.lstatSync(lock);
    if (
      !after.isFile() ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      fs.readFileSync(lock, 'utf8') !== content
    )
      return false;
    if (identity(pid) !== null) return false;
    audit();
    fs.unlinkSync(lock);
    return true;
  } catch {
    return false;
  }
}
