import { describe, expect, it } from 'vitest';

import { PANEL_WINDOW_STORAGE_KEY, PANEL_WINDOW_TITLE_HEIGHT_PX } from '../src/constants.js';
import {
  clampPanelRect,
  defaultPanelRect,
  readPanelPreferences,
  savePanelPreferences,
} from '../src/office/panelWindowState.js';

describe('viewer-local panel preferences', () => {
  it.each([
    null,
    '{broken',
    'null',
    '[]',
    '{}',
    '{"lastTab":"unknown","rect":null}',
    '{"lastTab":"audit","rect":{"x":0,"y":0,"width":-1,"height":200}}',
    '{"lastTab":"audit","rect":{"x":"0","y":0,"width":600,"height":200}}',
  ])('falls back safely for missing or corrupt storage %s', (value) => {
    expect(readPanelPreferences({ getItem: () => value })).toEqual({
      rect: null,
      lastTab: 'backlog',
    });
  });
  it('round-trips geometry and the selected tab, including mobile before any desktop geometry', () => {
    let saved: string | null = null;
    const storage = {
      getItem: (key: string) => {
        expect(key).toBe(PANEL_WINDOW_STORAGE_KEY);
        return saved;
      },
      setItem: (key: string, value: string) => {
        expect(key).toBe(PANEL_WINDOW_STORAGE_KEY);
        saved = value;
      },
    };
    for (const rect of [null, { x: 64, y: 150, width: 720, height: 500 }]) {
      const preferences = { rect, lastTab: 'features' as const };
      savePanelPreferences(storage, preferences);
      expect(readPanelPreferences(storage)).toEqual(preferences);
    }
  });
  it('works with throwing storage', () => {
    expect(
      readPanelPreferences({
        getItem: () => {
          throw new Error('denied');
        },
      }),
    ).toEqual({ rect: null, lastTab: 'backlog' });
    expect(() =>
      savePanelPreferences(
        {
          setItem: () => {
            throw new Error('full');
          },
        },
        { rect: null, lastTab: 'audit' },
      ),
    ).not.toThrow();
  });
  it('keeps the title bar reachable after shrink and clamps invalid resize attempts', () => {
    const rect = clampPanelRect(
      { x: 1300, y: 800, width: 900, height: 700 },
      { width: 600, height: 400 },
    );
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(600);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.y + PANEL_WINDOW_TITLE_HEIGHT_PX).toBeLessThanOrEqual(400);
    const resized = clampPanelRect(
      { ...rect, width: -100, height: -100 },
      { width: 600, height: 400 },
    );
    expect(resized.width).toBeGreaterThan(0);
    expect(resized.height).toBeGreaterThanOrEqual(PANEL_WINDOW_TITLE_HEIGHT_PX);
  });
  it('fits the default window between measured office controls', () => {
    const rect = defaultPanelRect({ width: 1024, height: 844 }, 200, 730);
    expect(rect.y).toBe(200);
    expect(rect.y + rect.height).toBeLessThanOrEqual(730);
    expect(rect.x).toBeGreaterThan(48);
    expect(rect.x + rect.width).toBeLessThanOrEqual(1024);
  });
});
