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
