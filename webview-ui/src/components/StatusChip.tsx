import { DOCK_ICON_SIZE_PX, STATUS_ICONS } from '../constants.js';
import { statusPresentation } from '../office/statusPresentation.js';

export function StatusChip({ state }: { state: string }) {
  const status = statusPresentation(state);
  return (
    <span className="status-chip" data-tone={status.tone} data-state={state}>
      <svg
        width={DOCK_ICON_SIZE_PX}
        height={DOCK_ICON_SIZE_PX}
        viewBox="0 0 16 16"
        fill="currentColor"
        shapeRendering="crispEdges"
        aria-hidden="true"
      >
        <path d={STATUS_ICONS[status.icon]} />
      </svg>
      {status.label}
    </span>
  );
}
