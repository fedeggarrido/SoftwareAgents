import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

const unknown = (provider: 'claude' | 'codex'): ProviderQuota => ({
  provider,
  status: 'unknown',
  usedPercent: null,
  resetsAt: null,
  observedAt: null,
});

export function claudeQuota(runsDir: string | undefined, nowS: number): ProviderQuota {
  if (!runsDir) return unknown('claude');
  for (const file of newestFiles(runsDir, 30)) {
    const lines = tailLines(file, 2_000_000);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limit_event"')) continue;
      let info: Record<string, unknown>;
      try {
        info =
          (JSON.parse(lines[i]) as { rate_limit_info?: Record<string, unknown> }).rate_limit_info ??
          {};
      } catch {
        continue;
      }
      return parseClaudeRateLimit(info, nowS, Math.round(fs.statSync(file).mtimeMs / 1000));
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
      const p = limits.primary;
      if (!p) continue;
      const win = (w: Record<string, number> | undefined): QuotaWindow | undefined => {
        if (!w) return undefined;
        const resetsAt = typeof w.resets_at === 'number' ? w.resets_at : null;
        const reset = resetsAt !== null && resetsAt <= nowS;
        return {
          usedPercent: reset ? null : (w.used_percent ?? null),
          resetsAt,
          windowMinutes: w.window_minutes,
        };
      };
      const primary = win(p)!;
      const weekly = win(limits.secondary);
      const observedAt = Math.round(fs.statSync(file).mtimeMs / 1000);
      const exhausted = (primary.usedPercent ?? 0) >= 100 || (weekly?.usedPercent ?? 0) >= 100;
      const status = exhausted
        ? 'rejected'
        : primary.usedPercent === null
          ? 'reset'
          : primary.usedPercent >= 90
            ? 'warning'
            : 'allowed';
      return {
        provider: 'codex',
        status,
        usedPercent: primary.usedPercent,
        resetsAt: primary.resetsAt,
        observedAt,
        weekly,
      };
    }
  }
  return unknown('codex');
}

/** Shared normalization for headless stream events and observed run logs. */
export function parseClaudeRateLimit(
  info: Record<string, unknown>,
  nowS: number,
  observedAt: number,
): ProviderQuota {
  const resetsAt = typeof info.resetsAt === 'number' ? info.resetsAt : null;
  const util = typeof info.utilization === 'number' ? Math.round(info.utilization * 100) : null;

  if (resetsAt !== null && resetsAt <= nowS) {
    return { provider: 'claude', status: 'reset', usedPercent: null, resetsAt, observedAt };
  }
  const raw = String(info.status ?? '');
  const status =
    raw === 'rejected' ? 'rejected' : raw === 'allowed_warning' ? 'warning' : 'allowed';
  return { provider: 'claude', status, usedPercent: util, resetsAt, observedAt };
}
