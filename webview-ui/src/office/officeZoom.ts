import {
  CAMERA_FOLLOW_LERP,
  CAMERA_FOLLOW_SNAP_THRESHOLD,
  TILE_SIZE,
  ZOOM_MAX,
  ZOOM_MIN,
} from '../constants.js';
import type { OfficeLayout } from './types.js';
import { TileType } from './types.js';

type LayoutGrid = Pick<OfficeLayout, 'cols' | 'rows' | 'tiles'>;
export interface CameraFrame {
  zoom: number;
  pan: { x: number; y: number };
}

interface Bounds {
  col: number;
  row: number;
  cols: number;
  rows: number;
}

/** The part of the layout that has floor or walls: empty (void) margins are not office. */
export function occupiedBounds(layout: LayoutGrid): Bounds {
  let [top, bottom, left, right] = [layout.rows, -1, layout.cols, -1];
  layout.tiles.forEach((tile, index) => {
    if (tile === TileType.VOID) return;
    const row = Math.floor(index / layout.cols);
    const col = index % layout.cols;
    [top, bottom] = [Math.min(top, row), Math.max(bottom, row)];
    [left, right] = [Math.min(left, col), Math.max(right, col)];
  });
  if (bottom < 0) return { col: 0, row: 0, cols: layout.cols, rows: layout.rows };
  return { col: left, row: top, cols: right - left + 1, rows: bottom - top + 1 };
}

/** Largest integer zoom that shows the whole office; integers keep the pixel grid. */
export function fitZoom(
  width: number,
  height: number,
  dpr: number,
  cols: number,
  rows: number,
): number {
  const byWidth = (width * dpr) / (cols * TILE_SIZE);
  const byHeight = (height * dpr) / (rows * TILE_SIZE);
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.floor(Math.min(byWidth, byHeight))));
}

/** Camera that frames the occupied office: zoom plus the pan that centres it. */
export function fitCamera(
  size: { width: number; height: number },
  dpr: number,
  layout: LayoutGrid,
): CameraFrame {
  const bounds = occupiedBounds(layout);
  const zoom = fitZoom(size.width, size.height, dpr, bounds.cols, bounds.rows);
  // Same convention as camera follow: pan = map centre - focus, in device pixels.
  const focusX = (bounds.col + bounds.cols / 2) * TILE_SIZE;
  const focusY = (bounds.row + bounds.rows / 2) * TILE_SIZE;
  return {
    zoom,
    pan: {
      x: ((layout.cols * TILE_SIZE) / 2 - focusX) * zoom,
      y: ((layout.rows * TILE_SIZE) / 2 - focusY) * zoom,
    },
  };
}

/** The camera frames the office until the user zooms or pans; then it is theirs. */
export class OfficeZoomPolicy {
  private mode: 'fit' | 'manual' = 'fit';
  private automaticZoom: number;
  constructor(zoom: number) {
    this.automaticZoom = zoom;
  }
  observe(zoom: number): void {
    if (zoom !== this.automaticZoom) this.mode = 'manual';
  }
  takeOver(): void {
    this.mode = 'manual';
  }
  fit(
    size: { width: number; height: number },
    dpr: number,
    layout: LayoutGrid,
    following: boolean,
  ): CameraFrame | null {
    if (this.mode === 'manual' || following) return null;
    const camera = fitCamera(size, dpr, layout);
    this.automaticZoom = camera.zoom;
    return camera;
  }
}

/** One step of the camera easing towards a followed point (pan = map centre - focus). */
export function followPan(
  pan: { x: number; y: number },
  focus: { x: number; y: number },
  layout: Pick<OfficeLayout, 'cols' | 'rows'>,
  zoom: number,
): { x: number; y: number } {
  const targetX = (layout.cols * TILE_SIZE * zoom) / 2 - focus.x * zoom;
  const targetY = (layout.rows * TILE_SIZE * zoom) / 2 - focus.y * zoom;
  const dx = targetX - pan.x;
  const dy = targetY - pan.y;
  if (Math.abs(dx) < CAMERA_FOLLOW_SNAP_THRESHOLD && Math.abs(dy) < CAMERA_FOLLOW_SNAP_THRESHOLD)
    return { x: targetX, y: targetY };
  return { x: pan.x + dx * CAMERA_FOLLOW_LERP, y: pan.y + dy * CAMERA_FOLLOW_LERP };
}
