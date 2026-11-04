import { describe, expect, it } from 'vitest';

import {
  PR_DISPLAY_CHECKS,
  PR_DISPLAY_TEXT_CHARS,
  PR_OBSERVATION_STALE_MS,
} from '../../core/src/constants.js';
import type { BoardItem, PullRequestStatus } from '../../core/src/messages.js';
import { projectPullRequest, projectPullRequestObservation } from '../../core/src/pullRequest.js';
import { pullRequestDockSummary, taskPullRequestLabel } from '../src/office/prStatusView.js';

const pr: PullRequestStatus = {
  ref: '42',
  state: 'OPEN',
  isDraft: true,
  reviewDecision: '',
  ci: 'pending',
  failedChecks: [],
  mergedAt: null,
  url: 'https://github.com/example/project/pull/42',
  headRefName: 'sa/task',
  observedAt: Date.now(),
};
const item = (key: string, status?: PullRequestStatus): BoardItem => ({
  id: key,
  title: key,
  phase: 'REVIEW',
  agentIds: [],
  prRef: '42',
  prStatus: status,
});

describe('PR labels in task details and dock', () => {
  it('ages a previous success and shows errors immediately in cards and the dock', () => {
    const success = { ...pr, ci: 'success' as const, observedAt: 1000 };
    const observed = {
      ...item('task', success),
      prObservation: { lastSuccessAt: 1000, attemptedAt: 1000, error: null },
    };
    expect(taskPullRequestLabel(observed, 1000)).toContain('CI success');
    expect(taskPullRequestLabel(observed, 1001 + PR_OBSERVATION_STALE_MS)).toContain('CI stale');
    const failed = {
      ...observed,
      prObservation: {
        ...observed.prObservation,
        attemptedAt: 2000,
        error: 'unavailable' as const,
      },
    };
    expect(taskPullRequestLabel(failed, 2000)).toContain('CI unavailable');
    expect(taskPullRequestLabel(failed, 2000)).not.toContain('CI success');
    expect(pullRequestDockSummary([failed], 2000)!.label).toContain('unavailable 1');
    expect(pullRequestDockSummary([observed], 1001 + PR_OBSERVATION_STALE_MS)!.label).toContain(
      'stale 1',
    );
  });
  it('bounds legacy persisted checks and rejects corrupt freshness metadata', () => {
    const projected = projectPullRequest(
      JSON.stringify({ ...pr, failedChecks: Array.from({ length: 100 }, () => 'x'.repeat(1000)) }),
    );
    expect(projected!.failedChecks).toHaveLength(PR_DISPLAY_CHECKS);
    expect(projected!.failedChecks[0]).toHaveLength(PR_DISPLAY_TEXT_CHARS);
    expect(projectPullRequestObservation('{corrupt')).toMatchObject({ error: 'unavailable' });
    expect(
      projectPullRequestObservation('{"attemptedAt":1,"lastSuccessAt":1,"error":"raw gh output"}'),
    ).toMatchObject({ error: 'unavailable' });
  });
  it('shows observed PR, draft, review and CI state', () => {
    expect(taskPullRequestLabel(item('task', pr))).toBe('PR OPEN (draft) · CI pending');
    expect(
      taskPullRequestLabel(
        item('task', { ...pr, isDraft: false, reviewDecision: 'APPROVED', ci: 'success' }),
      ),
    ).toBe('PR OPEN · CI success · APPROVED');
    expect(taskPullRequestLabel(item('task', { ...pr, state: 'MERGED', ci: 'failure' }))).toContain(
      'PR MERGED',
    );
  });
  it('keeps unobserved and mismatched PR references unknown', () => {
    expect(taskPullRequestLabel(item('task'))).toBe('PR 42 · CI unavailable');
    expect(taskPullRequestLabel(item('task', { ...pr, ref: '43' }))).toBe('PR 42 · CI unavailable');
    expect(taskPullRequestLabel({})).toBeNull();
  });
  it('summarizes CI states without displaying unknown observations as green', () => {
    const summary = pullRequestDockSummary([
      item('a', pr),
      item('b', { ...pr, ci: 'failure' }),
      item('c'),
    ]);
    expect(summary?.label).toBe('PR 3 · CI pending 1 / failure 1 / unavailable 1');
    expect(summary?.title).toContain('a · PR OPEN (draft) · CI pending');
    expect(pullRequestDockSummary([])).toBeNull();
  });
});
