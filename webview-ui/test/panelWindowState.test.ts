import { describe, expect, it } from 'vitest';

import {
  AGENT_CARD_Z_INDEX,
  MODAL_Z_INDEX,
  PANEL_WINDOW_MIN_HEIGHT_PX,
  PANEL_WINDOW_MIN_WIDTH_PX,
  PANEL_WINDOW_STORAGE_KEY,
  PANEL_WINDOW_TITLE_HEIGHT_PX,
  PANEL_WINDOW_Z_INDEX,
} from '../src/constants.js';
import {
  clampPanelRect,
  defaultPanelRect,
  fitPanelRect,
  readPanelPreferences,
  resizePanelRect,
  restorePanelRect,
  savePanelPreferences,
} from '../src/office/panelWindowState.js';

describe('viewer-local panel preferences', () => {
  it.each([120, 239, 900, Number.NaN])(
    'replaces invalid restored height %s with the viewport-aware default',
    (height) => {
      const viewport = { width: 1024, height: 844 };
      expect(restorePanelRect({ x: 64, y: 110, width: 720, height }, viewport, 104, 780)).toEqual(
        defaultPanelRect(viewport, 104, 780),
      );
    },
  );
  it('preserves valid dimensions and fits the default into a small viewport', () => {
    const rect = { x: 64, y: 110, width: 600, height: 400 };
    expect(restorePanelRect(rect, { width: 1024, height: 844 }, 104, 780)).toEqual(rect);
    const small = restorePanelRect(rect, { width: 390, height: 300 }, 104, 280);
    expect(small.width).toBeLessThanOrEqual(390);
    expect(small.y + small.height).toBeLessThanOrEqual(280);
  });
  it('migrates the removed character tab to Backlog while retaining geometry', () => {
    const rect = { x: 64, y: 150, width: 720, height: 500 };
    expect(
      readPanelPreferences({ getItem: () => JSON.stringify({ rect, lastTab: 'character' }) }),
    ).toEqual({ rect, lastTab: 'backlog' });
  });
  it('keeps selected character actions above the window and below modals', () => {
    expect(AGENT_CARD_Z_INDEX).toBeGreaterThan(PANEL_WINDOW_Z_INDEX);
    expect(AGENT_CARD_Z_INDEX).toBeLessThan(MODAL_Z_INDEX);
  });
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
  it.each([1024, 1440])('reclamps existing geometry below expanded controls at %i', (width) => {
    const rect = fitPanelRect(
      { x: 64, y: 100, width: 720, height: 520 },
      { width, height: 844 },
      460,
      780,
    );
    expect(rect.y).toBeGreaterThanOrEqual(460);
    expect(rect.y + rect.height).toBeLessThanOrEqual(780);
    const crowded = fitPanelRect(rect, { width, height: 300 }, 500, 260);
    expect(crowded.y).toBeGreaterThanOrEqual(0);
    expect(crowded.y + PANEL_WINDOW_TITLE_HEIGHT_PX).toBeLessThanOrEqual(300);
  });
  it.each(['w', 'n'])('keeps the opposite edge fixed when resizing %s past minimum', (edge) => {
    const rect = { x: 64, y: 100, width: 720, height: 520 };
    const resized = resizePanelRect(rect, edge, 1000, 1000);
    expect(resized.x + resized.width).toBe(rect.x + rect.width);
    expect(resized.y + resized.height).toBe(rect.y + rect.height);
    expect(edge === 'w' ? resized.width : resized.height).toBe(
      edge === 'w' ? PANEL_WINDOW_MIN_WIDTH_PX : PANEL_WINDOW_MIN_HEIGHT_PX,
    );
  });
});
