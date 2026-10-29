import { describe, expect, it } from 'vitest';

import {
  isAgentEnvironmentFailure,
  isVerifierInfrastructureFailure,
  VerifierInfrastructureError,
} from '../src/verifierInfrastructure.js';

it.each([
  'environment blocked',
  'Environment is blocked',
  'sandbox execution denied',
  'sandbox: permission denied',
  'command not available',
  'command is not available',
  'executable not found',
  'permission denied by the sandbox',
])('recognizes explicit environment blocker: %s', (summary) => {
  expect(isAgentEnvironmentFailure(summary)).toBe(true);
  const error = new VerifierInfrastructureError('agent reported an environment blocker');
  expect(isVerifierInfrastructureFailure(error.message)).toBe(true);
  expect(isVerifierInfrastructureFailure('QA failed: ' + error.message)).toBe(true);
});
it.each([
  'AssertionError: expected true to be false',
  'Tests failed',
  'Please implement sandbox support',
])('does not exempt product failures: %s', (summary) => {
  expect(isAgentEnvironmentFailure(summary)).toBe(false);
});

describe('isAgentEnvironmentFailure opening line', () => {
  it('ignores summaries that only describe command-not-found behaviour later on', () => {
    expect(
      isAgentEnvironmentFailure(
        'Implemented the CLI.\nIt prints "command not found" for unknown verbs.',
      ),
    ).toBe(false);
    expect(isAgentEnvironmentFailure('Environment blocked: sandbox execution denied')).toBe(true);
  });
});
