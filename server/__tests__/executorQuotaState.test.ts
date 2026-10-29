import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import type { AgentSpec } from '../../core/src/agentSpec.js';
import { EXECUTOR_QUOTA_FAILURE_THRESHOLD } from '../src/constants.js';
import { eventsFromTransition } from '../src/domainEventRelay.js';
import { executorQuotaAvailability } from '../src/executorAvailability.js';
import {
  isQuotaDiagnostic,
  isTransientDiagnostic,
  quotaBackoffSeconds,
  readExecutorQuota,
  recordExecutorQuota,
  recordExecutorQuotaSuccess,
  retryAtFromDiagnostic,
} from '../src/executorQuotaState.js';
import { selectExecutor } from '../src/executorSelection.js';

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: () => process.env.HOME ?? actual.homedir() };
});
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-state-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it('persists consecutive rejections across readers and automatically expires at reset', () => {
  for (let i = 1; i <= EXECUTOR_QUOTA_FAILURE_THRESHOLD; i++)
    expect(recordExecutorQuota('codex', 200, 100)).toMatchObject({
      failures: i,
      unavailable: i >= EXECUTOR_QUOTA_FAILURE_THRESHOLD,
    });
  expect(readExecutorQuota('codex', 199)?.resetsAt).toBe(200);
  expect(executorQuotaAvailability('codex', 199)).toEqual({ available: false, resetsAt: 200 });
  recordExecutorQuotaSuccess('codex', 199);
  expect(recordExecutorQuota('codex', 200, 199).failures).toBe(1);
  expect(readExecutorQuota('codex', 200)).toBeUndefined();
  expect(executorQuotaAvailability('codex', 200)).toEqual({ available: true, resetsAt: null });
  expect(recordExecutorQuota('codex', 400, 201).failures).toBe(1);
});
it('uses a configurable positive backoff and distinguishes transport failure', () => {
  vi.stubEnv('SOFTWAREAGENTS_QUOTA_BACKOFF_SECONDS', '45');
  expect(quotaBackoffSeconds()).toBe(45);
  expect(isQuotaDiagnostic("You've hit your usage limit")).toBe(true);
  expect(isQuotaDiagnostic('HTTP 429 rate limit exceeded')).toBe(true);
  expect(isQuotaDiagnostic('HTTP 503 temporarily unavailable')).toBe(false);
  expect(isTransientDiagnostic('HTTP 503 temporarily unavailable')).toBe(true);
});
it.each([true, false])(
  'quota fallback requires fallbackAllowed=%s and fresh admission',
  (allowed) => {
    const agent = parse(
      fs.readFileSync(path.resolve(__dirname, '../../agents/templates/architect.yaml'), 'utf8'),
    ) as AgentSpec;
    agent.modelPolicy.fallbackAllowed = allowed;
    const snapshot = {
      allowedExecutors: ['claude', 'codex'],
      nowS: 100,
      active: { claude: 0, codex: 0 },
      machinePolicy: {
        quotaThresholds: { claude: 5, codex: 5 },
        maxConcurrent: { claude: 1, codex: 1 },
      },
      capacities: {
        claude: {
          provider: 'claude' as const,
          status: 'rejected' as const,
          source: 'estimated' as const,
          confidence: 'high' as const,
          observedAt: 100,
          windows: [{ kind: 'other' as const, usedRatio: 1, resetsAt: 200 }],
        },
      },
    };
    const policy = {
      high_reasoning: [{ executor: 'claude' as const }, { executor: 'codex' as const }],
    };
    const result = selectExecutor(agent, policy, snapshot);
    expect(result.choice?.executor).toBe(allowed ? 'codex' : 'claude');
    expect(result.gate.status).toBe(allowed ? 'probe' : 'wait');
    snapshot.active.codex = 1;
    expect(selectExecutor(agent, policy, snapshot).gate.status).toBe('wait');
  },
);
it('relays the existing quota.exhausted domain event from a durable quota wait', () => {
  expect(
    eventsFromTransition(
      'project',
      {
        id: 1,
        task_key: 'SA-038',
        from_status: 'RUNNING',
        to_status: 'WAITING_QUOTA',
        task_version: 2,
        attempt: 0,
        reason: JSON.stringify({ cause: 'quota', reason: 'rejected', resetsAt: 200 }),
        created_at: new Date().toISOString(),
        agent_role: 'developer',
      },
      { executionId: 'run', decisionId: null },
    ).map((e) => e.kind),
  ).toContain('quota.exhausted');
});

// Real Codex CLI output captured in FEAT-002 (.git/softwareagents/runs).
const REAL_CODEX_LIMIT =
  'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 9:40 PM.';

it('detects the real Codex usage-limit message and its local reset time', () => {
  expect(isQuotaDiagnostic(REAL_CODEX_LIMIT)).toBe(true);
  const now = new Date(2026, 9, 28, 18, 0, 0);
  expect(retryAtFromDiagnostic(REAL_CODEX_LIMIT, now)).toBe(
    Math.floor(new Date(2026, 9, 28, 21, 40, 0).getTime() / 1000),
  );
  // After 21:40 the next occurrence is tomorrow.
  const late = new Date(2026, 9, 28, 22, 0, 0);
  expect(retryAtFromDiagnostic(REAL_CODEX_LIMIT, late)).toBe(
    Math.floor(new Date(2026, 9, 29, 21, 40, 0).getTime() / 1000),
  );
  expect(retryAtFromDiagnostic('try again later', now)).toBeUndefined();
  expect(retryAtFromDiagnostic('try again at 13:00 PM', now)).toBeUndefined();
});
