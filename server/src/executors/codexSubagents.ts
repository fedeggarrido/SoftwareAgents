import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CODEX_SUBAGENT_HEADER_BYTES } from '../constants.js';

/** Where Codex writes rollouts: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`. The Executor
 *  inherits the Operator's environment, so this is the same CODEX_HOME the spawned CLI uses. */
export function codexSessionsDirectory(env = process.env): string {
  return path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
}

/** Day folders a rollout started in [sinceMs, nowMs] can land in, in local time and UTC. */
function dayFolders(root: string, sinceMs: number, nowMs: number): string[] {
  const folders = new Set<string>();
  const pad = (n: number) => String(n).padStart(2, '0');
  for (const ms of [sinceMs, nowMs])
    for (const d of [new Date(ms)]) {
      folders.add(
        path.join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())),
      );
      folders.add(
        path.join(root, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())),
      );
    }
  return [...folders];
}

/**
 * A sub-agent's rollout opens with a `session_meta` line carrying `parent_thread_id` (Codex
 * 0.160.0). Returns the first rollout spawned by `parentThreadId` since `sinceMs`, or undefined.
 * `seen` remembers files whose header was fully read and did not match, so each is read once.
 */
export function findSubagentRollout(
  root: string,
  parentThreadId: string,
  sinceMs: number,
  seen: Set<string>,
  nowMs = Date.now(),
): string | undefined {
  const needle = `"parent_thread_id":"${parentThreadId}"`;
  for (const folder of dayFolders(root, sinceMs, nowMs)) {
    let names: string[];
    try {
      names = fs.readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(folder, name);
      if (!name.endsWith('.jsonl') || seen.has(file)) continue;
      let fd: number | undefined;
      try {
        if (fs.statSync(file).mtimeMs < sinceMs) {
          seen.add(file);
          continue;
        }
        fd = fs.openSync(file, 'r');
        const buffer = Buffer.alloc(CODEX_SUBAGENT_HEADER_BYTES);
        const header = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString();
        const newline = header.indexOf('\n');
        if (header.slice(0, newline < 0 ? undefined : newline).includes(needle)) return file;
        // Mark seen only once the header line is complete (or too long to matter).
        if (newline >= 0 || header.length >= CODEX_SUBAGENT_HEADER_BYTES) seen.add(file);
      } catch {
        /* vanished or locked mid-write: retry on the next poll */
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
  }
  return undefined;
}
