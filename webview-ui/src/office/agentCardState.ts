import {
  AGENT_CARD_GAP_PX,
  AGENT_CARD_MAX_HEIGHT_PX,
  AGENT_CARD_WIDTH_PX,
  PANEL_MOBILE_BREAKPOINT_PX,
  PANEL_WINDOW_MARGIN_PX,
} from '../constants.js';

export function agentCardPosition(
  anchor: { x: number; y: number },
  viewport: { width: number; height: number },
) {
  const margin = PANEL_WINDOW_MARGIN_PX;
  const mobile = viewport.width <= PANEL_MOBILE_BREAKPOINT_PX;
  const width = Math.max(0, Math.min(AGENT_CARD_WIDTH_PX, viewport.width - margin * 2));
  const maxHeight = Math.max(0, Math.min(AGENT_CARD_MAX_HEIGHT_PX, viewport.height - margin * 2));
  return {
    mobile,
    width: mobile ? Math.max(0, viewport.width - margin * 2) : width,
    maxHeight,
    left: mobile
      ? margin
      : Math.max(margin, Math.min(anchor.x + AGENT_CARD_GAP_PX, viewport.width - width - margin)),
    top: mobile
      ? undefined
      : Math.max(margin, Math.min(anchor.y, viewport.height - maxHeight - margin)),
    bottom: mobile ? margin : undefined,
  };
}
