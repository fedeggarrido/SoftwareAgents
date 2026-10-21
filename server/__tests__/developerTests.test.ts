import { describe, expect, it } from 'vitest';

import { validateDeveloperTests } from '../src/developerTests.js';

const check = (source: string) => () =>
  validateDeveloperTests('e2e/tests/standalone/x.spec.ts', source, '');

describe('validateDeveloperTests', () => {
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

  it('still rejects a test without assertions and skipped groups', () => {
    expect(check("test('empty', async () => {});")).toThrow(/requires an assertion/);
    expect(
      check("test.describe.skip('g', () => { test('t', () => { expect(1).toBe(1); }); });"),
    ).toThrow(/skip\/todo\/only/);
  });
});
