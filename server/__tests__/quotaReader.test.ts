import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { quotaGate } from '../src/quotaGate.js';
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

  it.each(['claude', 'codex'] as const)(
    'uses the %s quota event timestamp, never mtime or unrelated appends',
    (provider) => {
      const file = path.join(dir, 'event.jsonl');
      const timestamp = new Date((NOW - 61) * 1000).toISOString();
      const record =
        provider === 'claude'
          ? {
              type: 'rate_limit_event',
              timestamp,
              rate_limit_info: {
                status: 'allowed_warning',
                utilization: 0.91,
                resetsAt: NOW + 600,
              },
            }
          : {
              type: 'event_msg',
              timestamp,
              payload: {
                type: 'token_count',
                rate_limits: { primary: { used_percent: 91, resets_at: NOW + 600 } },
              },
            };
      fs.writeFileSync(
        file,
        JSON.stringify(record) +
          '\n' +
          JSON.stringify({ type: 'unrelated', timestamp: new Date(NOW * 1000).toISOString() }),
      );
      fs.utimesSync(file, NOW, NOW);
      const snapshot =
        provider === 'claude' ? claudeQuota(dir, NOW).capacity : codexQuota(NOW, dir).capacity;
      expect(snapshot?.observedAt).toBe(NOW - 61);
      expect(
        quotaGate(
          provider,
          { quotaThresholds: { [provider]: 5 }, maxConcurrent: { [provider]: 2 } },
          snapshot,
          0,
          NOW,
        ).status,
      ).toBe('probe');
    },
  );
  it('missing quota event time remains unknown despite a recent file mtime', () => {
    fs.writeFileSync(
      path.join(dir, 'run.jsonl'),
      tokenCount({ used_percent: 20, resets_at: NOW + 600 }),
    );
    const snapshot = codexQuota(NOW, dir).capacity;
    expect(snapshot?.observedAt).toBeNull();
    expect(
      quotaGate(
        'codex',
        { quotaThresholds: { codex: 10 }, maxConcurrent: { codex: 2 } },
        snapshot,
        0,
        NOW,
      ).status,
    ).toBe('probe');
  });
  it('keeps all normalized Claude windows so a reset cannot hide a live weekly rejection', () => {
    fs.writeFileSync(
      path.join(dir, 'run.jsonl'),
      JSON.stringify({
        type: 'rateLimit',
        capacity: {
          provider: 'claude',
          status: 'rejected',
          source: 'claude_stream_json',
          confidence: 'high',
          observedAt: NOW - 61,
          windows: [
            { kind: 'five_hour', usedRatio: 1, resetsAt: NOW },
            { kind: 'weekly', usedRatio: 1, resetsAt: NOW + 600 },
          ],
        },
      }),
    );
    const snapshot = claudeQuota(dir, NOW).capacity;
    expect(snapshot?.windows).toHaveLength(2);
    expect(
      quotaGate(
        'claude',
        { quotaThresholds: { claude: 10 }, maxConcurrent: { claude: 2 } },
        snapshot,
        0,
        NOW,
      ),
    ).toMatchObject({ status: 'wait', resetsAt: NOW + 600 });
  });

  it('is unknown, never available, when nothing was observed', () => {
    expect(claudeQuota(dir, NOW).status).toBe('unknown');
    expect(codexQuota(NOW, dir).status).toBe('unknown');
  });

  it('keeps allowed Claude capacity unmeasured below 90 percent', () => {
    fs.writeFileSync(
      path.join(dir, 'run.jsonl'),
      rateLimit({ status: 'allowed', utilization: 0.4, rateLimitType: 'five_hour' }),
    );
    expect(claudeQuota(dir, NOW)).toMatchObject({
      usedPercent: null,
      capacity: {
        source: 'claude_stream_json',
        confidence: 'low',
        windows: [{ kind: 'five_hour', usedRatio: null }],
      },
    });
  });
  it('reads normalized registry events and clears expired capacity', () => {
    fs.writeFileSync(
      path.join(dir, 'run.jsonl'),
      JSON.stringify({
        type: 'rateLimit',
        message: 'rejected',
        retryAfterSec: 600,
        capacity: {
          provider: 'claude',
          status: 'rejected',
          source: 'claude_stream_json',
          confidence: 'high',
          observedAt: NOW,
          windows: [{ kind: 'weekly', usedRatio: 1, resetsAt: NOW + 600 }],
        },
      }),
    );
    expect(claudeQuota(dir, NOW).capacity).toMatchObject({
      status: 'rejected',
      confidence: 'high',
      observedAt: NOW,
      windows: [{ kind: 'weekly', usedRatio: 1 }],
    });
    expect(claudeQuota(dir, NOW + 601).capacity).toMatchObject({
      status: 'reset',
      confidence: 'unknown',
      windows: [{ usedRatio: null }],
    });
  });
  it('does not infer quota from token usage', () => {
    fs.writeFileSync(
      path.join(dir, 'run.jsonl'),
      JSON.stringify({ type: 'usage', inputTokens: 500, outputTokens: 100 }),
    );
    expect(claudeQuota(dir, NOW).capacity).toMatchObject({
      status: 'unknown',
      confidence: 'unknown',
      windows: [],
    });
  });
  it('reads old registry rateLimit events with low confidence', () => {
    fs.writeFileSync(
      path.join(dir, 'run.jsonl'),
      JSON.stringify({ type: 'rateLimit', message: 'allowed', retryAfterSec: 0 }),
    );
    expect(claudeQuota(dir, NOW).capacity).toMatchObject({
      status: 'allowed',
      confidence: 'low',
      windows: [{ usedRatio: null }],
    });
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

  it('does not treat an empty Codex quota block as a reset', () => {
    fs.writeFileSync(path.join(dir, 'rollout.jsonl'), tokenCount({}));
    expect(codexQuota(NOW, dir).capacity).toMatchObject({
      status: 'unknown',
      confidence: 'unknown',
      windows: [],
    });
  });
  it('clears both expired Codex windows without claiming fresh capacity', () => {
    fs.writeFileSync(
      path.join(dir, 'rollout.jsonl'),
      tokenCount(
        { used_percent: 100, window_minutes: 300, resets_at: NOW - 1 },
        { used_percent: 100, window_minutes: 10080, resets_at: NOW - 1 },
      ),
    );
    expect(codexQuota(NOW, dir).capacity).toMatchObject({
      status: 'reset',
      confidence: 'unknown',
      windows: [
        { kind: 'five_hour', usedRatio: null },
        { kind: 'weekly', usedRatio: null },
      ],
    });
  });
  it('reports a weekly Codex warning even when the five-hour window is healthy', () => {
    fs.writeFileSync(
      path.join(dir, 'rollout.jsonl'),
      tokenCount(
        { used_percent: 10, window_minutes: 300, resets_at: NOW + 600 },
        { used_percent: 95, window_minutes: 10080, resets_at: NOW + 600 },
      ),
    );
    expect(codexQuota(NOW, dir).capacity).toMatchObject({
      status: 'warning',
      source: 'codex_session_log',
      confidence: 'high',
      windows: [{ usedRatio: 0.1 }, { usedRatio: 0.95 }],
    });
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
