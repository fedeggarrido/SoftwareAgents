import { afterEach, expect, it, vi } from 'vitest';

import { runReviewCommand } from '../src/commands/review.js';

const mocks = vi.hoisted(() => ({
  record: vi.fn(async () => {}),
  close: vi.fn(),
  open: vi.fn(),
}));
vi.mock('../src/projectConfig.js', () => ({
  loadProjectConfig: () => ({ repoRoot: '.', project: { id: 'p' } }),
}));
vi.mock('../src/workstore/SqliteWorkStore.js', () => ({ openWorkStore: mocks.open }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it('refuses agent ingress before opening any store', async () => {
  vi.stubEnv('SA_MANAGED_EXECUTION', '1');
  await expect(runReviewCommand(['finding', 'T', '0', '--accept'])).rejects.toThrow(
    'human ingress',
  );
  expect(mocks.open).not.toHaveBeenCalled();
});

it('records a human decision on the persisted verifier execution', async () => {
  for (const key of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(key, undefined);
  mocks.open.mockResolvedValue({
    getTask: () => ({ key: 'T', feature_key: 'FEAT-001', review_reports: [{ execution_id: 'E' }] }),
    listExecutions: () => [{ key: 'E', task_version: 1, started_at: '2026-01-01' }],
    recordFindingDecision: mocks.record,
    close: mocks.close,
  });
  await runReviewCommand(
    ['finding', 'T', '0', '--reject', '--reason', 'Expected behavior'],
    '.',
    () => {},
  );
  expect(mocks.record).toHaveBeenCalledWith(
    expect.objectContaining({
      task: 'T',
      execution: 'E',
      index: 0,
      actor: 'human',
      decision: 'reject',
      reason: 'Expected behavior',
    }),
  );
  expect(mocks.close).toHaveBeenCalledOnce();
});

it('rejects conflicting decisions and negative indexes before store access', async () => {
  for (const args of [
    ['finding', 'T', '-1', '--accept'],
    ['finding', 'T', '0', '--accept', '--reject'],
  ])
    await expect(runReviewCommand(args)).rejects.toThrow();
  expect(mocks.open).not.toHaveBeenCalled();
});
