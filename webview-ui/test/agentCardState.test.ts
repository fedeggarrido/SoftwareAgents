import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { agentCardPosition } from '../src/office/agentCardState.js';

describe('agent card geometry and contrast', () => {
  it.each([390, 1024, 1440])('stays inside a %ipx viewport for offscreen characters', (width) => {
    for (const anchor of [
      { x: -100, y: -100 },
      { x: width + 100, y: 1000 },
    ]) {
      const position = agentCardPosition(anchor, { width, height: 844 });
      expect(position.left).toBeGreaterThanOrEqual(0);
      expect(position.left + position.width).toBeLessThanOrEqual(width);
      expect(position.mobile).toBe(width === 390);
      if (position.top !== undefined) {
        expect(position.top).toBeGreaterThanOrEqual(0);
        expect(position.top + position.maxHeight).toBeLessThanOrEqual(844);
      } else expect(position.bottom).toBeGreaterThan(0);
    }
  });
  it('uses AA contrast for the card text and each button state', () => {
    const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    const color = (token: string) =>
      css.match(new RegExp(`--color-${token}: (#[0-9a-f]+|rgb\\([^)]+\\))`))![1];
    const luminance = (value: string) => {
      const channels = value.startsWith('#')
        ? value
            .slice(1)
            .match(/../g)!
            .map((x) => parseInt(x, 16))
        : value.match(/\d+/g)!.map(Number);
      const [r, g, b] = channels.map((x) => {
        const s = x / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return r * 0.2126 + g * 0.7152 + b * 0.0722;
    };
    // Muted text sits on the card. Default buttons inherit normal text;
    // the transparent close button changes from muted to normal on hover.
    for (const [fg, bg] of [
      ['text', 'bg'],
      ['text-muted', 'bg'],
      ['text', 'btn-bg'],
      ['text', 'btn-hover'],
    ]) {
      const a = luminance(color(fg)),
        b = luminance(color(bg));
      expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
