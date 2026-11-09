import {
  PANEL_TABS,
  PANEL_WINDOW_DEFAULT_HEIGHT_PX,
  PANEL_WINDOW_DEFAULT_LEFT_PX,
  PANEL_WINDOW_DEFAULT_TOP_PX,
  PANEL_WINDOW_DEFAULT_WIDTH_PX,
  PANEL_WINDOW_MARGIN_PX,
  PANEL_WINDOW_MIN_HEIGHT_PX,
  PANEL_WINDOW_MIN_WIDTH_PX,
  PANEL_WINDOW_STORAGE_KEY,
  PANEL_WINDOW_TITLE_HEIGHT_PX,
} from '../constants.js';

export type PanelTab = (typeof PANEL_TABS)[number]['id'];
export interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PanelViewport {
  width: number;
  height: number;
}
export interface PanelPreferences {
  rect: PanelRect | null;
  lastTab: PanelTab;
}
interface ViewerStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function clampPanelRect(rect: PanelRect, viewport: PanelViewport): PanelRect {
  const availableWidth = Math.max(0, viewport.width - PANEL_WINDOW_MARGIN_PX * 2);
  const availableHeight = Math.max(0, viewport.height - PANEL_WINDOW_MARGIN_PX * 2);
  const width = Math.min(availableWidth, Math.max(PANEL_WINDOW_MIN_WIDTH_PX, rect.width));
  const height = Math.min(availableHeight, Math.max(PANEL_WINDOW_MIN_HEIGHT_PX, rect.height));
  return {
    x: Math.max(
      PANEL_WINDOW_MARGIN_PX,
      Math.min(rect.x, viewport.width - width - PANEL_WINDOW_MARGIN_PX),
    ),
    y: Math.max(
      PANEL_WINDOW_MARGIN_PX,
      Math.min(rect.y, viewport.height - PANEL_WINDOW_TITLE_HEIGHT_PX - PANEL_WINDOW_MARGIN_PX),
    ),
    width,
    height,
  };
}

/** Occupied top/bottom bounds come from the rendered HUD, notices, zoom and dock. */
export function defaultPanelRect(
  viewport: PanelViewport,
  top = PANEL_WINDOW_DEFAULT_TOP_PX,
  bottom = viewport.height - PANEL_WINDOW_MARGIN_PX,
): PanelRect {
  return fitPanelRect(
    {
      x: PANEL_WINDOW_DEFAULT_LEFT_PX,
      y: top,
      width: PANEL_WINDOW_DEFAULT_WIDTH_PX,
      height: Math.min(PANEL_WINDOW_DEFAULT_HEIGHT_PX, Math.max(0, bottom - top)),
    },
    viewport,
    top,
    bottom,
  );
}

/** Keep the window between changing office controls; title reachability takes precedence
 * if the controls leave less than a title's worth of space. */
export function fitPanelRect(
  proposed: PanelRect,
  viewport: PanelViewport,
  top: number,
  bottom: number,
): PanelRect {
  const rect = clampPanelRect(proposed, viewport);
  const end = Math.max(
    PANEL_WINDOW_MARGIN_PX + PANEL_WINDOW_TITLE_HEIGHT_PX,
    Math.min(bottom, viewport.height - PANEL_WINDOW_MARGIN_PX),
  );
  const start = Math.max(PANEL_WINDOW_MARGIN_PX, Math.min(top, end - PANEL_WINDOW_TITLE_HEIGHT_PX));
  const height = Math.min(rect.height, end - start);
  return {
    ...rect,
    y: Math.max(start, Math.min(rect.y, end - height)),
    height,
  };
}

/** Resize from the opposite, fixed edge before applying viewport constraints. */
export function resizePanelRect(rect: PanelRect, edge: string, dx: number, dy: number): PanelRect {
  const next = { ...rect };
  if (edge.includes('e')) next.width = Math.max(PANEL_WINDOW_MIN_WIDTH_PX, rect.width + dx);
  if (edge.includes('s')) next.height = Math.max(PANEL_WINDOW_MIN_HEIGHT_PX, rect.height + dy);
  if (edge.includes('w')) {
    next.width = Math.max(PANEL_WINDOW_MIN_WIDTH_PX, rect.width - dx);
    next.x = rect.x + rect.width - next.width;
  }
  if (edge.includes('n')) {
    next.height = Math.max(PANEL_WINDOW_MIN_HEIGHT_PX, rect.height - dy);
    next.y = rect.y + rect.height - next.height;
  }
  return next;
}

export function readPanelPreferences(storage: Pick<ViewerStorage, 'getItem'>): PanelPreferences {
  const fallback: PanelPreferences = { rect: null, lastTab: 'backlog' };
  try {
    const raw: unknown = JSON.parse(storage.getItem(PANEL_WINDOW_STORAGE_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return fallback;
    const candidate = raw as Record<string, unknown>;
    // The old character tab has moved to a separate card; retain the viewer's geometry.
    const lastTab = candidate.lastTab === 'character' ? 'backlog' : candidate.lastTab;
    if (!PANEL_TABS.some((tab) => tab.id === lastTab)) return fallback;
    if (candidate.rect === null) return { rect: null, lastTab: lastTab as PanelTab };
    const rect = candidate.rect as PanelRect | null;
    if (
      !rect ||
      ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
      rect.width <= 0 ||
      rect.height <= 0
    )
      return fallback;
    return { rect, lastTab: lastTab as PanelTab };
  } catch {
    return fallback;
  }
}

export function savePanelPreferences(
  storage: Pick<ViewerStorage, 'setItem'>,
  preferences: PanelPreferences,
): void {
  try {
    storage.setItem(PANEL_WINDOW_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Viewer storage can be unavailable or full. The window remains usable.
  }
}
