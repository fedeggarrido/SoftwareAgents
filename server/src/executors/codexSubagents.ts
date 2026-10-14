import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CODEX_SUBAGENT_HEADER_BYTES } from '../constants.js';

/** Resolve relative CODEX_HOME against the child cwd, just as Codex does. */
export function codexSessionsDirectory(env = process.env, cwd = process.cwd()): string {
  return path.join(
    path.resolve(cwd, env.CODEX_HOME || path.join(os.homedir(), '.codex')),
    'sessions',
  );
}

/** Include every calendar day in both clocks, including DST transitions. */
function dayFolders(root: string, sinceMs: number, nowMs: number): string[] {
  const folders = new Set<string>();
  const pad = (n: number) => String(n).padStart(2, '0');
  for (const utc of [false, true]) {
    const d = new Date(sinceMs);
    if (utc) d.setUTCHours(0, 0, 0, 0);
    else d.setHours(0, 0, 0, 0);
    while (d.getTime() <= nowMs) {
      folders.add(
        path.join(
          root,
          String(utc ? d.getUTCFullYear() : d.getFullYear()),
          pad((utc ? d.getUTCMonth() : d.getMonth()) + 1),
          pad(utc ? d.getUTCDate() : d.getDate()),
        ),
      );
      if (utc) d.setUTCDate(d.getUTCDate() + 1);
      else d.setDate(d.getDate() + 1);
    }
  }
  return [...folders];
}

export type SubagentRolloutStatus =
  | { status: 'found'; file: string }
  | { status: 'none' }
  | { status: 'inconclusive'; reason: string };

/** Cache only fully parsed nonmatching headers. Unreadable or unfinished headers must retry. */
export function findSubagentRollout(
  root: string,
  parentThreadId: string,
  sinceMs: number,
  seen: Set<string>,
  nowMs = Date.now(),
  final = false,
  onOwnRollout?: (file: string) => void,
): SubagentRolloutStatus {
  let reason: string | undefined;
  let ownRolloutFound = false;
  for (const folder of dayFolders(root, sinceMs, nowMs)) {
    let names: string[];
    try {
      names = fs.readdirSync(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        reason = `Cannot list rollout day: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`;
      continue;
    }
    for (const name of names) {
      const file = path.join(folder, name);
      const ownRollout = name.endsWith(`${parentThreadId}.jsonl`);
      if (ownRollout) ownRolloutFound = true;
      if (!name.endsWith('.jsonl') || seen.has(file)) continue;
      let fd: number | undefined;
      try {
        const stat = fs.statSync(file);
        // An existing session cannot be a newly spawned child, even if it keeps writing.
        // Unknown creation times remain candidates and therefore fail closed on parse errors.
        if (
          !ownRollout &&
          (stat.mtimeMs < sinceMs || (stat.birthtimeMs > 0 && stat.birthtimeMs < sinceMs))
        ) {
          seen.add(file);
          continue;
        }
        fd = fs.openSync(file, 'r');
        const buffer = Buffer.alloc(CODEX_SUBAGENT_HEADER_BYTES);
        const header = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString();
        const newline = header.indexOf('\n');
        if (newline < 0) {
          reason = 'Rollout session_meta header is incomplete or exceeds the read limit';
          continue;
        }
        const meta = JSON.parse(header.slice(0, newline));
        if (meta?.type !== 'session_meta' || !meta.payload || typeof meta.payload !== 'object') {
          reason = 'Rollout has no valid session_meta header';
          continue;
        }
        const payload = meta.payload;
        if (ownRollout && payload.id === parentThreadId) onOwnRollout?.(file);
        if (
          payload.parent_thread_id === parentThreadId ||
          payload.source?.subagent?.thread_spawn?.parent_thread_id === parentThreadId
        )
          return { status: 'found', file };
        seen.add(file);
      } catch (error) {
        reason = `Cannot inspect rollout header: ${(error as NodeJS.ErrnoException).code ?? 'invalid JSON'}`;
      } finally {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            reason = 'Cannot close rollout header';
          }
        }
      }
    }
  }
  if (final && !ownRolloutFound)
    return { status: 'inconclusive', reason: 'Own thread rollout not found in scanned days' };
  return reason ? { status: 'inconclusive', reason } : { status: 'none' };
}
