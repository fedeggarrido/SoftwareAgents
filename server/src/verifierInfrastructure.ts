/** Infrastructure failures require an operator retry, never another agent attempt. */
export const VERIFIER_INFRASTRUCTURE_PREFIX = 'Verifier infrastructure: ';

export class VerifierInfrastructureError extends Error {
  constructor(reason: string) {
    super(VERIFIER_INFRASTRUCTURE_PREFIX + reason);
  }
}

export function isVerifierInfrastructureFailure(reason: string | null | undefined): boolean {
  return ['', 'Reviewer failed: ', 'QA failed: '].some((prefix) =>
    reason?.startsWith(prefix + VERIFIER_INFRASTRUCTURE_PREFIX),
  );
}

/** Explicit agent-reported environment blockers, independent of CLI exit status. Only the
 * opening line counts: a report that merely describes "command not found" behaviour of the
 * feature (or mentions it later) is not a blocker. */
export function isAgentEnvironmentFailure(summary: string): boolean {
  const opening = summary.trimStart().split(/\r?\n/, 1)[0];
  return /^\W*(?:environment (?:is )?blocked\b|sandbox[: ]+(?:access |execution |permission )?(?:denied|blocked)\b|(?:command|executable) (?:is )?(?:not (?:available|found)|unavailable)\b|permission denied by (?:the )?sandbox\b)/i.test(
    opening,
  );
}
