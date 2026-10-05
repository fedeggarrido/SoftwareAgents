import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { CapacitySnapshot } from '../../core/src/capacity.js';

/**
 * Last observed quota of each provider. Mirrors the company's own gate
 * (scripts/<project>_quota.py) so the office and the launchers agree:
 *  - Claude: `rate_limit_event` records in the headless run logs. Below 90 %
 *    Claude only says "allowed"; from 90 % it reports the utilization.
 *  - Codex: the `rate_limits` block of the newest `token_count` in
 *    ~/.codex/sessions (5-hour primary window, weekly secondary window).
 * A window whose reset time already passed is reported as reset, never with
 * its stale percentage. Nothing observed means `unknown`, never "available".
 */

export interface QuotaWindow {
  usedPercent: number | null;
  resetsAt: number | null;
  windowMinutes?: number;
}

export interface ProviderQuota {
  provider: 'claude' | 'codex';
  status: 'allowed' | 'warning' | 'rejected' | 'reset' | 'unknown';
  usedPercent: number | null;
  resetsAt: number | null;
  observedAt: number | null;
  weekly?: QuotaWindow;
  capacity?: CapacitySnapshot;
}

function tailLines(file: string, maxBytes: number): string[] {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, maxBytes);
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf-8').split('\n');
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function newestFiles(dir: string, limit: number, recursive = false): string[] {
  const out: { file: string; mtime: number }[] = [];
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && recursive && depth < 4) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          out.push({ file: full, mtime: fs.statSync(full).mtimeMs });
        } catch {
          /* vanished */
        }
      }
    }
  };
  walk(dir, 0);
  return out
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((x) => x.file);
}

function capacity(
  q: ProviderQuota,
  kind: 'five_hour' | 'weekly' | 'other' = 'other',
): ProviderQuota {
  q.capacity = {
    provider: q.provider,
    status: q.status,
    observedAt: q.observedAt,
    source:
      q.status === 'unknown'
        ? 'estimated'
        : q.provider === 'claude'
          ? 'claude_stream_json'
          : 'codex_session_log',
    confidence:
      q.status === 'unknown' || q.status === 'reset'
        ? 'unknown'
        : q.usedPercent === null
          ? 'low'
          : 'high',
    windows:
      q.status === 'unknown'
        ? []
        : [
            {
              kind,
              usedRatio: q.usedPercent === null ? null : q.usedPercent / 100,
              resetsAt: q.resetsAt,
            },
            ...(q.weekly
              ? [
                  {
                    kind: 'weekly' as const,
                    usedRatio: q.weekly.usedPercent === null ? null : q.weekly.usedPercent / 100,
                    resetsAt: q.weekly.resetsAt,
                  },
                ]
              : []),
          ],
  };
  return q;
}
const unknown = (provider: 'claude' | 'codex'): ProviderQuota =>
  capacity({
    provider,
    status: 'unknown',
    usedPercent: null,
    resetsAt: null,
    observedAt: null,
  });

/** Event time only: unrelated appends/mtime changes never refresh quota evidence. */
function eventObservedAt(record: { timestamp?: unknown }): number | null {
  if (typeof record.timestamp !== 'string') return null;
  const ms = Date.parse(record.timestamp);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

export function claudeQuota(runsDir: string | undefined, nowS: number): ProviderQuota {
  if (!runsDir) return unknown('claude');
  for (const file of newestFiles(runsDir, 30)) {
    const lines = tailLines(file, 2_000_000);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limit_event"') && !lines[i].includes('"rateLimit"')) continue;
      let info: Record<string, unknown>;
      try {
        const record = JSON.parse(lines[i]);
        if (record.type === 'rateLimit') {
          const c = record.capacity;
          const observed =
            typeof c?.observedAt === 'number' && Number.isFinite(c.observedAt)
              ? c.observedAt
              : eventObservedAt(record);
          const status = c?.status ?? record.message;
          if (!['allowed', 'warning', 'rejected', 'reset'].includes(status)) continue;
          info = {
            status: status === 'warning' ? 'allowed_warning' : status,
            utilization: c?.windows?.[0]?.usedRatio,
            rateLimitType: c?.windows?.[0]?.kind === 'weekly' ? 'seven_day' : c?.windows?.[0]?.kind,
            resetsAt:
              c?.windows?.[0]?.resetsAt ??
              (observed !== null && record.retryAfterSec > 0
                ? observed + record.retryAfterSec
                : null),
          };
          const q = parseClaudeRateLimit(info, nowS, observed);
          if (!c) q.capacity!.confidence = q.status === 'reset' ? 'unknown' : 'low';
          else if (Array.isArray(c.windows) && c.windows.length > 0) {
            const windows = c.windows.filter(
              (w: CapacitySnapshot['windows'][number]) =>
                ['five_hour', 'weekly', 'other'].includes(w.kind) &&
                (w.usedRatio === null ||
                  (Number.isFinite(w.usedRatio) && w.usedRatio >= 0 && w.usedRatio <= 1)) &&
                (w.resetsAt === null || Number.isFinite(w.resetsAt)),
            );
            if (windows.length !== c.windows.length) continue;
            const live = windows.filter(
              (w: CapacitySnapshot['windows'][number]) => w.resetsAt === null || w.resetsAt > nowS,
            );
            q.capacity = {
              ...q.capacity!,
              windows: windows.map((w: CapacitySnapshot['windows'][number]) =>
                w.resetsAt !== null && w.resetsAt <= nowS ? { ...w, usedRatio: null } : w,
              ),
              status: live.length ? status : 'reset',
              confidence:
                live.length && ['unknown', 'low', 'high', 'exact'].includes(c.confidence)
                  ? c.confidence
                  : 'unknown',
            };
            q.status = q.capacity.status;
          }
          return q;
        }
        if (record.type !== 'rate_limit_event') continue;
        info = record.rate_limit_info ?? {};
      } catch {
        continue;
      }
      return parseClaudeRateLimit(info, nowS, eventObservedAt(JSON.parse(lines[i])));
    }
  }
  return unknown('claude');
}

export function codexQuota(
  nowS: number,
  sessionsRoot = path.join(os.homedir(), '.codex', 'sessions'),
): ProviderQuota {
  for (const file of newestFiles(sessionsRoot, 12, true)) {
    const lines = tailLines(file, 400_000);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let limits: Record<string, Record<string, number> | undefined>;
      try {
        limits =
          (JSON.parse(lines[i]) as { payload?: { rate_limits?: typeof limits } }).payload
            ?.rate_limits ?? {};
      } catch {
        continue;
      }
      if (!limits.primary) continue;
      return parseCodexRateLimits(limits, nowS, eventObservedAt(JSON.parse(lines[i])));
    }
  }
  return unknown('codex');
}

/** Shared normalization for headless stream events and observed run logs. */
export function parseClaudeRateLimit(
  info: Record<string, unknown>,
  nowS: number,
  observedAt: number | null,
): ProviderQuota {
  const resetsAt =
    typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? info.resetsAt : null;
  const util =
    typeof info.utilization === 'number' &&
    Number.isFinite(info.utilization) &&
    info.utilization >= 0 &&
    info.utilization <= 1
      ? Math.round(info.utilization * 100)
      : null;

  const raw = String(info.status ?? '');
  const reportedStatus =
    raw === 'rejected'
      ? 'rejected'
      : raw === 'allowed_warning' || raw === 'warning'
        ? 'warning'
        : raw === 'allowed'
          ? 'allowed'
          : raw === 'reset'
            ? 'reset'
            : 'unknown';
  const status =
    reportedStatus !== 'unknown' && resetsAt !== null && resetsAt <= nowS
      ? 'reset'
      : reportedStatus;
  return capacity(
    {
      provider: 'claude',
      status,
      usedPercent: status === 'allowed' || status === 'unknown' || status === 'reset' ? null : util,
      resetsAt,
      observedAt,
    },
    info.rateLimitType === 'five_hour'
      ? 'five_hour'
      : info.rateLimitType === 'seven_day'
        ? 'weekly'
        : 'other',
  );
}

/** Shared Codex normalization for observed token_count rate_limits. */
export function parseCodexRateLimits(
  limits: Record<string, Record<string, number> | undefined>,
  nowS: number,
  observedAt: number | null = nowS,
): ProviderQuota {
  const p = limits.primary;
  if (!p) return unknown('codex');
  const win = (w: Record<string, number> | undefined): QuotaWindow | undefined => {
    if (!w) return undefined;
    const resetsAt =
      typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) ? w.resets_at : null;
    const reset = resetsAt !== null && resetsAt <= nowS;
    return {
      usedPercent: reset
        ? null
        : typeof w.used_percent === 'number' &&
            Number.isFinite(w.used_percent) &&
            w.used_percent >= 0 &&
            w.used_percent <= 100
          ? w.used_percent
          : null,
      resetsAt,
      windowMinutes: w.window_minutes,
    };
  };
  const primary = win(p)!;
  const weekly = win(limits.secondary);

  const exhausted = (primary.usedPercent ?? 0) >= 100 || (weekly?.usedPercent ?? 0) >= 100;
  const status = exhausted
    ? 'rejected'
    : (primary.usedPercent ?? 0) >= 90 || (weekly?.usedPercent ?? 0) >= 90
      ? 'warning'
      : primary.usedPercent === null
        ? primary.resetsAt !== null && primary.resetsAt <= nowS
          ? 'reset'
          : 'unknown'
        : 'allowed';
  return capacity(
    {
      provider: 'codex',
      status,
      usedPercent: primary.usedPercent,
      resetsAt: primary.resetsAt,
      observedAt,
      weekly,
    },
    p.window_minutes === 300 ? 'five_hour' : 'other',
  );
}
