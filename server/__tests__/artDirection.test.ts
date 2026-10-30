/* eslint-disable pixel-agents/no-inline-colors -- Deliberate sRGB input fixtures for contrast validation. */
import { describe, expect, it } from 'vitest';

import {
  applyDirectionTokens,
  DIRECTION_WEIGHTS,
  validateArtDirection,
  validateDirectionSystem,
} from '../src/artDirection.js';

export function proposal() {
  return {
    diagnosis: 'Professional workspace for supervised software delivery',
    recommendation: 'swiss',
    drawbacks: 'Restrained expression',
    directions: ['swiss', 'editorial', 'retro'].map((id) => ({
      id,
      name: id,
      style: id,
      influences: id,
      personality: id,
      composition: id,
      colorStrategy: id,
      typographyIconography: id,
      advantages: 'Clear hierarchy',
      limitations: 'Needs careful density',
      risks: 'Migration effort',
      fit: 'Long working sessions',
      complexity: 'Medium',
      scores: Object.fromEntries(Object.keys(DIRECTION_WEIGHTS).map((k) => [k, 4])),
      total: 999,
    })),
  };
}
describe('art direction runtime contract', () => {
  it('recomputes dishonest totals using fixed weights', () => {
    const value = proposal();
    value.directions[0].scores.suitability = 5;
    const validated = validateArtDirection(JSON.stringify(value));
    expect(validated.directions.map((d) => d.total)).toEqual([4.25, 4, 4]);
  });
  it('rejects fewer than three, similar identities and invalid scores', () => {
    const value = proposal();
    expect(() =>
      validateArtDirection(JSON.stringify({ ...value, directions: value.directions.slice(0, 2) })),
    ).toThrow();
    value.directions[1].style = 'SWISS';
    value.directions[1].composition = 'Swiss!';
    expect(() => validateArtDirection(JSON.stringify(value))).toThrow(/share/);
    const bad = proposal();
    bad.directions[0].scores.accessibility = 6;
    expect(() => validateArtDirection(JSON.stringify(bad))).toThrow();
  });
  it('checks approved token contrasts and changes only :root declarations', () => {
    const input = {
      colorSystem: 'Harmony, HEX, OKLCH, scales and forbidden pairs',
      designSystem: 'Typography and components',
      tokens: [
        { name: '--color-bg', value: '#000000' },
        { name: '--color-text', value: '#ffffff' },
      ],
      approved: [{ foreground: '--color-text', background: '--color-bg', usage: 'normal' }],
    };
    const { system, contrasts } = validateDirectionSystem(JSON.stringify(input));
    expect(contrasts[0].ratio).toBe(21);
    const tail = '\nbutton { color: var(--color-text); }';
    const css = applyDirectionTokens(
      ':root { --color-bg: #111111; --color-text: #eeeeee; }' + tail,
      system.tokens,
    );
    expect(css).toContain('--color-bg: #000000;');
    expect(css.endsWith(tail)).toBe(true);
    expect(() =>
      applyDirectionTokens(':root { --other--color-bg: #111111; }', system.tokens),
    ).toThrow(/Unknown project token/);
    input.tokens[1].value = '#111111';
    expect(() => validateDirectionSystem(JSON.stringify(input))).toThrow(/contrast fails/);
    input.tokens[1].value = 'red; } body { display:none';
    expect(() => validateDirectionSystem(JSON.stringify(input))).toThrow();
  });
});
