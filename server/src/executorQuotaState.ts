import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  EXECUTOR_QUOTA_FAILURE_THRESHOLD,
  LAYOUT_FILE_DIR,
  QUOTA_BACKOFF_SECONDS,
} from './constants.js';
import type { ExecutorId } from './executors/executor.js';

interface QuotaState {
  failures: number;
  resetsAt: number;
  unavailable?: boolean;
}

function statePath(executor: ExecutorId): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, 'executor-quota', `${executor}.json`);
}

export function readExecutorQuota(executor: ExecutorId, nowS: number): QuotaState | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(executor), 'utf8')) as QuotaState;
    if (!Number.isInteger(value.failures) || value.failures < 0 || !Number.isFinite(value.resetsAt))
      throw new Error('Invalid executor quota state');
    return value.resetsAt > nowS ? value : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Caller holds machine admission, shared with every slot reservation. */
export function recordExecutorQuota(executor: ExecutorId, resetsAt: number, nowS: number) {
  const previous = readExecutorQuota(executor, nowS);
  const state = {
    failures: (previous?.failures ?? 0) + 1,
    resetsAt: Math.max(previous?.resetsAt ?? 0, resetsAt),
    unavailable:
      previous?.unavailable === true ||
      (previous?.failures ?? 0) + 1 >= EXECUTOR_QUOTA_FAILURE_THRESHOLD,
  };
  persistQuotaState(executor, state);
  return state;
}

function persistQuotaState(executor: ExecutorId, state: QuotaState): void {
  const file = statePath(executor);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

/** An already admitted successful execution breaks the consecutive failure streak.
 * Keep the rejection evidence until reset: success is not proof of renewed quota. */
export function recordExecutorQuotaSuccess(executor: ExecutorId, nowS: number): void {
  const previous = readExecutorQuota(executor, nowS);
  if (previous) persistQuotaState(executor, { ...previous, failures: 0 });
}

export function quotaBackoffSeconds(): number {
  const configured = Number(process.env.SOFTWAREAGENTS_QUOTA_BACKOFF_SECONDS);
  return Number.isFinite(configured) && configured > 0 ? configured : QUOTA_BACKOFF_SECONDS;
}

/** CLI diagnostics only; callers must never feed tool output or successful prose. */
export function isQuotaDiagnostic(text: string): boolean {
  return /\b(?:usage[ _-]?limit|rate[ _-]?limit|quota[ _-]?(?:exceeded|exhausted)|429)\b|you(?:'|’)ve hit your limit/i.test(
    text,
  );
}

/** Codex usage limits say "try again at 9:40 PM" (local wall clock, no date): the next
 * occurrence of that time, in epoch seconds. Unparseable text falls back to the backoff. */
export function retryAtFromDiagnostic(text: string, now: Date): number | undefined {
  const match = /try again at (\d{1,2}):(\d{2})\s*([AP]M)?/i.exec(text);
  if (!match) return undefined;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3]?.toUpperCase();
  if (minutes > 59 || hours > (meridiem ? 12 : 23) || (meridiem && hours === 0)) return undefined;
  if (meridiem) hours = (hours % 12) + (meridiem === 'PM' ? 12 : 0);
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return Math.floor(at.getTime() / 1000);
}

export function isTransientDiagnostic(text: string): boolean {
  return /\b(?:50[0234]|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH)\b|network error|connection (?:reset|closed)|temporarily unavailable/i.test(
    text,
  );
}
