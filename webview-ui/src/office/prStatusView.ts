import type { BoardItem } from '../../../core/src/messages.js';
import { CHARACTER_DETAIL_UNKNOWN } from '../constants.js';

/** Shared read-only labels for task cards and the dock. */
export function taskPullRequestLabel(item: Pick<BoardItem, 'prRef' | 'prStatus'>): string | null {
  if (!item.prRef) return null;
  const pr = item.prStatus?.ref === item.prRef ? item.prStatus : undefined;
  if (!pr) return `PR ${item.prRef} · CI ${CHARACTER_DETAIL_UNKNOWN}`;
  return `PR ${pr.state}${pr.isDraft ? ' (draft)' : ''} · CI ${pr.ci}${pr.reviewDecision ? ` · ${pr.reviewDecision}` : ''}`;
}

export function pullRequestDockSummary(
  items: readonly BoardItem[],
): { label: string; title: string } | null {
  const prs = items.filter((item) => item.prRef);
  if (!prs.length) return null;
  const counts = new Map<string, number>();
  for (const item of prs) {
    const status = item.prStatus;
    const state = status && status.ref === item.prRef ? status.ci : 'unknown';
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return {
    label: `PR ${prs.length} · CI ${[...counts].map(([state, count]) => `${state} ${count}`).join(' / ')}`,
    title: prs.map((item) => `${item.id} · ${taskPullRequestLabel(item)}`).join('\n'),
  };
}
