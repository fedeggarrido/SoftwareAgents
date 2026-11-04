import {
  PR_DISPLAY_CHECKS,
  PR_DISPLAY_REF_CHARS,
  PR_DISPLAY_TEXT_CHARS,
  PR_OBSERVATION_STALE_MS,
} from './constants.js';
import type { PullRequestObservation, PullRequestStatus } from './messages.js';

export function pullRequestCi(
  status: PullRequestStatus | undefined,
  observation: PullRequestObservation | undefined,
  now = Date.now(),
): string {
  if (!status || observation?.error) return 'unavailable';
  const success = observation?.lastSuccessAt ?? status.observedAt;
  if (!Number.isFinite(success) || now < success || now - success > PR_OBSERVATION_STALE_MS)
    return 'stale';
  return status.ci;
}

/** Bound old persisted rows as well as current validated observations. */
export function projectPullRequest(json: string | null): PullRequestStatus | undefined {
  if (!json) return undefined;
  try {
    const status = JSON.parse(json) as PullRequestStatus;
    if (
      !Array.isArray(status.failedChecks) ||
      typeof status.ref !== 'string' ||
      typeof status.url !== 'string' ||
      typeof status.headRefName !== 'string' ||
      status.ref.length > PR_DISPLAY_REF_CHARS ||
      status.url.length > PR_DISPLAY_REF_CHARS ||
      !['OPEN', 'CLOSED', 'MERGED'].includes(status.state) ||
      !['unknown', 'pending', 'success', 'failure'].includes(status.ci) ||
      !['', 'APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(status.reviewDecision) ||
      typeof status.isDraft !== 'boolean' ||
      !Number.isFinite(status.observedAt)
    )
      return undefined;
    return {
      ref: status.ref,
      state: status.state,
      isDraft: status.isDraft,
      reviewDecision: status.reviewDecision,
      ci: status.ci,
      mergedAt:
        typeof status.mergedAt === 'string' && Number.isFinite(Date.parse(status.mergedAt))
          ? status.mergedAt.slice(0, PR_DISPLAY_TEXT_CHARS)
          : null,
      url: status.url,
      headRefName: status.headRefName.slice(0, PR_DISPLAY_TEXT_CHARS),
      observedAt: status.observedAt,
      failedChecks: status.failedChecks
        .slice(0, PR_DISPLAY_CHECKS)
        .filter((name) => typeof name === 'string')
        .map((name) =>
          name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, PR_DISPLAY_TEXT_CHARS),
        ),
    };
  } catch {
    return undefined;
  }
}

export function projectPullRequestObservation(
  json: string | null,
): PullRequestObservation | undefined {
  if (!json) return undefined;
  try {
    const value = JSON.parse(json) as PullRequestObservation;
    if (
      (value.lastSuccessAt === null || Number.isFinite(value.lastSuccessAt)) &&
      Number.isFinite(value.attemptedAt) &&
      [null, 'unavailable', 'binding_required'].includes(value.error)
    )
      return {
        lastSuccessAt: value.lastSuccessAt,
        attemptedAt: value.attemptedAt,
        error: value.error,
      };
  } catch {
    /* Invalid metadata cannot project old CI as current. */
  }
  return { lastSuccessAt: null, attemptedAt: 0, error: 'unavailable' };
}
