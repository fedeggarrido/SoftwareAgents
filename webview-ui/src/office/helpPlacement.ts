import { PANEL_WINDOW_MARGIN_PX } from '../constants.js';

/** The popover stays below the HUD and scrolls within the remaining viewport. */
export function officeHelpPlacement(naturalTop: number, hudBottom: number, viewportHeight: number) {
  const top = Math.max(naturalTop, hudBottom + PANEL_WINDOW_MARGIN_PX);
  return {
    marginTop: top - naturalTop,
    maxHeight: Math.max(0, viewportHeight - top - PANEL_WINDOW_MARGIN_PX),
  };
}
