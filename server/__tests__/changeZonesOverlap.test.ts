import { describe, expect, it } from 'vitest';

import { zonesOverlap } from '../src/changeZones.js';

describe('declared zone intersection', () => {
  it.each([
    ['server/src', 'server/src/foo.ts', true],
    ['docs/**', 'server/**', false],
    ['core/asyncapi.yaml', 'core/*.yaml', true],
    ['core/**/asyncapi.*', 'core/asyncapi.yaml', true],
    ['server/*/foo.ts', 'server/src/*.ts', true],
    ['src/a*.ts', 'src/b*.ts', false],
    ['src/*a.ts', 'src/b*.ts', true],
    ['src/**/a.ts', 'src/a.ts', true],
    ['docs/', 'docs/a/b.md', true],
    ['src/*/', 'src/nested/deep/foo.ts', true],
    ['CORE/*.YAML', 'core/asyncapi.yaml', true],
  ])('%s vs %s', (a, b, expected) => {
    expect(zonesOverlap(a, b)).toBe(expected);
    expect(zonesOverlap(b, a)).toBe(expected);
  });
});
