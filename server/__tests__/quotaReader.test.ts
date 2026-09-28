import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claudeQuota, codexQuota } from '../src/quotaReader.js';

const NOW = 1_790_600_000;

function rateLimit(info: Record<string, unknown>): string {
  return JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info }) + '\n';
}

function tokenCount(primary: Record<string, number>, secondary?: Record<string, number>): string {
  return (
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', rate_limits: { primary, secondary } },
    }) + '\n'
  );
}

describe('quotaReader', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is unknown, never available, when nothing was observed', () => {
    expect(claudeQuota(dir, NOW).status).toBe('unknown');
    expect(codexQuota(NOW, dir).status).toBe('unknown');
  });

  it('reads the last Claude event: exhausted until its reset', () => {
    fs.writeFileSync(
      path.join(dir, 'run.jsonl'),
      rateLimit({ status: 'allowed_warning', utilization: 0.93, resetsAt: NOW + 600 }) +
        rateLimit({ status: 'rejected', resetsAt: NOW + 600 }),
    );
    expect(claudeQuota(dir, NOW)).toMatchObject({ status: 'rejected', resetsAt: NOW + 600 });
  });

  it('reports a warning with its percentage from 90 %', () => {
    fs.writeFileSync(
      path.join(dir, 'run.jsonl'),
      rateLimit({ status: 'allowed_warning', utilization: 0.91, resetsAt: NOW + 600 }),
    );
    expect(claudeQuota(dir, NOW)).toMatchObject({ status: 'warning', usedPercent: 91 });
  });

  it('never repeats a percentage whose window already reset', () => {
    fs.writeFileSync(
      path.join(dir, 'run.jsonl'),
      rateLimit({ status: 'rejected', resetsAt: NOW - 1 }),
    );
    expect(claudeQuota(dir, NOW)).toMatchObject({ status: 'reset', usedPercent: null });
  });

  it('reads Codex 5-hour and weekly windows', () => {
    fs.mkdirSync(path.join(dir, '2026', '09', '28'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '2026', '09', '28', 'rollout.jsonl'),
      tokenCount(
        { used_percent: 42, window_minutes: 300, resets_at: NOW + 3600 },
        { used_percent: 14, window_minutes: 10080, resets_at: NOW + 86400 },
      ),
    );
    const q = codexQuota(NOW, dir);
    expect(q).toMatchObject({ status: 'allowed', usedPercent: 42 });
    expect(q.weekly?.usedPercent).toBe(14);
  });

  it('treats an exhausted weekly window as exhausted', () => {
    fs.writeFileSync(
      path.join(dir, 'rollout.jsonl'),
      tokenCount(
        { used_percent: 10, window_minutes: 300, resets_at: NOW + 3600 },
        { used_percent: 100, window_minutes: 10080, resets_at: NOW + 86400 },
      ),
    );
    expect(codexQuota(NOW, dir).status).toBe('rejected');
  });
});
