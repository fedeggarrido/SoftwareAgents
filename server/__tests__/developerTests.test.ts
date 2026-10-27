import { describe, expect, it } from 'vitest';

import { VERIFIER_FEEDBACK_MAX_CHARS, VERIFIER_FEEDBACK_MAX_LINES } from '../src/constants.js';
import { validateDeveloperTests } from '../src/developerTests.js';
import {
  styleOnlyFailures,
  verifierFailure,
  verifierFailureReason,
} from '../src/verifierFeedback.js';

const check = (source: string) => () =>
  validateDeveloperTests('e2e/tests/standalone/x.spec.ts', source, '');

describe('validateDeveloperTests', () => {
  it('sanitizes and bounds retry diagnostics and classifies mixed failures', () => {
    const failure = verifierFailure(
      'eslint',
      ['node', '/scratch/eslint.js'],
      ['x.ts'],
      'fail',
      '\u001b[31mx.ts:2 simple-import-sort/imports token=private sk-proj-private\u0000\n' +
        'diagnostic\n'.repeat(100),
      ['/scratch'],
    );
    expect(failure.command).toEqual(['node', '<runtime>/eslint.js']);
    expect(failure.detail).toContain('simple-import-sort/imports');
    expect(failure.detail).not.toMatch(/private|\u001b|\u0000/);
    expect(failure.detail.length).toBeLessThanOrEqual(VERIFIER_FEEDBACK_MAX_CHARS);
    expect(failure.detail.split('\n').length).toBeLessThanOrEqual(VERIFIER_FEEDBACK_MAX_LINES);
    expect(styleOnlyFailures([failure])).toBe(true);
    const tests = { ...failure, verifier: 'tests' as const };
    expect(styleOnlyFailures([failure, tests])).toBe(false);
    expect(verifierFailureReason([failure, tests])).toBe('verifier_failed: eslint|tests');
  });
  it('accepts a Playwright spec with test.use, test.describe and asserting tests', () => {
    // Shape of the real FEAT-001-T05 spec that was wrongly rejected.
    const spec = [
      "test.use({ locale: 'en-US' });",
      "test.describe('group', () => {",
      "  test('reads', async ({ page }) => { await expect(page).toHaveTitle('x'); });",
      "  test.describe('nested', () => {",
      '    test.use({ seed: false });',
      '    test.beforeEach(async () => { await Promise.resolve(); });',
      "    test('empty state', async () => { expect(1).toBe(1); });",
      '  });',
      '});',
    ].join('\n');
    expect(check(spec)).not.toThrow();
  });

  it('rejects node:test with a precise reason', () => {
    expect(
      check("import { test } from 'node:test';\ntest('x', () => { expect(1).toBe(1); });"),
    ).toThrow(/must use Vitest, not node:test/);
  });

  it('still rejects a test without assertions and skipped groups', () => {
    expect(check("test('empty', async () => {});")).toThrow(/requires an assertion/);
    expect(
      check("test.describe.skip('g', () => { test('t', () => { expect(1).toBe(1); }); });"),
    ).toThrow(/skip\/todo\/only/);
  });
});
