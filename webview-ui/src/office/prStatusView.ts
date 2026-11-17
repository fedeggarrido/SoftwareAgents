import { PR_DISPLAY_SUMMARY_CHARS, PR_DISPLAY_TEXT_CHARS } from '../../../core/src/constants.js';
import type { BoardItem } from '../../../core/src/messages.js';
import { pullRequestCi } from '../../../core/src/pullRequest.js';
import { es } from '../i18n/es.js';
import { pullRequestStateLabel } from './taskDetailPresentation.js';

/** Shared read-only labels for task cards and the dock. */
export function taskPullRequestLabel(
  item: Pick<BoardItem, 'prRef' | 'prStatus' | 'prObservation'>,
  now = Date.now(),
): string | null {
  if (!item.prRef) return null;
  const pr = item.prStatus?.ref === item.prRef ? item.prStatus : undefined;
  if (!pr) return es.pullRequest.unobserved(item.prRef.slice(0, PR_DISPLAY_TEXT_CHARS));
  return [
    pullRequestStateLabel(pr.state),
    pr.isDraft ? es.pullRequest.draft : '',
    pullRequestStateLabel(pullRequestCi(pr, item.prObservation, now)),
    pullRequestStateLabel(pr.reviewDecision),
  ]
    .filter(Boolean)
    .join(' · ');
}

export function pullRequestDockSummary(
  items: readonly BoardItem[],
  now = Date.now(),
): { label: string; title: string } | null {
  const prs = items.filter((item) => item.prRef);
  if (!prs.length) return null;
  const counts = new Map<string, number>();
  for (const item of prs) {
    const status = item.prStatus;
    const state = pullRequestCi(
      status?.ref === item.prRef ? status : undefined,
      item.prObservation,
      now,
    );
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return {
    label: es.pullRequest.summary(
      prs.length,
      [...counts].map(([state, count]) => `${pullRequestStateLabel(state)} ${count}`).join(' / '),
    ),
    title: prs
      .map((item) => `${item.id} · ${taskPullRequestLabel(item, now)}`)
      .join('\n')
      .slice(0, PR_DISPLAY_SUMMARY_CHARS),
  };
}
