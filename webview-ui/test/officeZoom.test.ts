import { describe, expect, it } from 'vitest';

import { fitCamera, fitZoom, occupiedBounds, OfficeZoomPolicy } from '../src/office/officeZoom.js';
import type { TileType as Tile } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

const grid = { cols: 20, rows: 11, tiles: Array<Tile>(220).fill(TileType.FLOOR_1) };
const phone = { width: 375, height: 700 };
const desktop = { width: 1440, height: 800 };

describe('office camera fit', () => {
  it.each([1, 2, 3])('fits the default office at 375 CSS pixels with DPR %s', (dpr) => {
    const zoom = fitZoom(375, 700, dpr, 20, 11);
    expect((20 * 16 * zoom) / dpr).toBeLessThanOrEqual(375);
    expect(Number.isInteger(zoom)).toBe(true);
  });
  it('fills a desktop window instead of keeping a small default', () => {
    const zoom = fitZoom(desktop.width, desktop.height, 1, grid.cols, grid.rows);
    expect(zoom).toBe(4);
    expect(20 * 16 * zoom).toBeLessThanOrEqual(1440);
    expect(11 * 16 * zoom).toBeLessThanOrEqual(800);
  });
  it('fits again after rotating or widening an untouched camera', () => {
    const policy = new OfficeZoomPolicy(2);
    expect(policy.fit(phone, 1, grid, false)?.zoom).toBe(1);
    policy.observe(1);
    expect(policy.fit(desktop, 1, grid, false)?.zoom).toBe(4);
  });
  it('frames only the occupied office and centres it', () => {
    // A 20x22 plan whose top 10 rows are empty space, like the default office.
    const tiles = Array.from({ length: 22 * 20 }, (_, i): Tile =>
      i < 200 || i >= 420 ? TileType.VOID : TileType.FLOOR_1,
    );
    const layout = { cols: 20, rows: 22, tiles };
    expect(occupiedBounds(layout)).toEqual({ col: 0, row: 10, cols: 20, rows: 11 });
    const camera = fitCamera(desktop, 1, layout);
    expect(camera.zoom).toBe(4);
    // Centre of rows 10..20 is row 15.5; map centre is row 11: pan up by 4.5 tiles.
    expect(camera.pan).toEqual({ x: 0, y: (11 - 15.5) * 16 * 4 });
  });
  it('gives the camera to the user after a manual pan', () => {
    const policy = new OfficeZoomPolicy(2);
    policy.takeOver();
    expect(policy.fit(desktop, 1, grid, false)).toBeNull();
  });
  it('leaves a followed camera alone', () => {
    const policy = new OfficeZoomPolicy(2);
    expect(policy.fit(phone, 1, grid, true)).toBeNull();
  });
  it('keeps manual ownership after returning to the fitted level', () => {
    const policy = new OfficeZoomPolicy(2);
    expect(policy.fit(phone, 1, grid, false)?.zoom).toBe(1);
    policy.observe(1);
    policy.observe(3);
    policy.observe(1);
    expect(policy.fit(desktop, 1, grid, false)).toBeNull();
  });
});
