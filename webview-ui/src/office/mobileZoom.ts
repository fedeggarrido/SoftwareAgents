import { DOCK_MOBILE_BREAKPOINT_PX, TILE_SIZE, ZOOM_MAX, ZOOM_MIN } from '../constants.js';

/** Integer device pixels preserve the renderer's pixel grid. */
export function mobileFitZoom(width: number, dpr: number, cols: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.floor((width * dpr) / (cols * TILE_SIZE))));
}

/** Manual ownership persists even when the user returns to the last fitted level. */
export class MobileZoomPolicy {
  private mode: 'fit' | 'manual' = 'fit';
  private automaticZoom: number;
  private readonly initialZoom: number;
  constructor(zoom: number) {
    this.initialZoom = zoom;
    this.automaticZoom = zoom;
  }
  observe(zoom: number): void {
    if (zoom !== this.automaticZoom) this.mode = 'manual';
  }
  fit(width: number, dpr: number, cols: number, following: boolean): number | null {
    if (this.mode === 'manual' || following) return null;
    // Widening back to a desktop width gives an untouched camera its original zoom.
    const target =
      width >= DOCK_MOBILE_BREAKPOINT_PX ? this.initialZoom : mobileFitZoom(width, dpr, cols);
    if (target === this.automaticZoom) return null;
    this.automaticZoom = target;
    return target;
  }
}
