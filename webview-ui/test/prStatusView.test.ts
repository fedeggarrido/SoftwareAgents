import { describe, expect, it } from 'vitest';

import type { BoardItem, PullRequestStatus } from '../../core/src/messages.js';
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
  observedAt: 1,
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
    expect(taskPullRequestLabel(item('task'))).toBe('PR 42 · CI desconocido');
    expect(taskPullRequestLabel(item('task', { ...pr, ref: '43' }))).toBe('PR 42 · CI desconocido');
    expect(taskPullRequestLabel({})).toBeNull();
  });
  it('summarizes CI states without displaying unknown observations as green', () => {
    const summary = pullRequestDockSummary([
      item('a', pr),
      item('b', { ...pr, ci: 'failure' }),
      item('c'),
    ]);
    expect(summary?.label).toBe('PR 3 · CI pending 1 / failure 1 / unknown 1');
    expect(summary?.title).toContain('a · PR OPEN (draft) · CI pending');
    expect(pullRequestDockSummary([])).toBeNull();
  });
});
