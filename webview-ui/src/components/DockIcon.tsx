import { DOCK_ICON_SIZE_PX } from '../constants.js';

const paths = {
  idea: 'M7 2h2v5h5v2H9v5H7V9H2V7h5z',
  backlog: 'M2 2h12v12H2zm2 2v8h8V4zM5 5h2v2H5zm3 0h3v2H8zM5 9h2v2H5zm3 0h3v2H8z',
  decisions: 'M2 2h12v10H9l-3 3v-3H2zm2 2v6h3v2l2-2h3V4zM7 5h2v2H7zm0 3h2v1H7z',
  features: 'M2 2h2v12H2zm2 0h10v7H4zm2 2v3h6V4z',
  audit: 'M3 1h8v2h2v12H3zm2 2v10h6V5H9V3zm1 3h3v2H6zm0 3h4v2H6z',
  edit: 'M10 1h2v2h2v2h-2V3h-2zM8 3h2v2H8zM6 5h2v2H6zM4 7h2v2H4zM2 9h2v3h3v2H2zm4 0h2v2H6zm2-2h2v2H8zm2-2h2v2h-2z',
  settings: 'M6 1h4v2h2v3h3v4h-3v2h-2v3H6v-3H4v-2H1V6h3V4h2zm0 5v4h4V6z',
  more: 'M2 7h2v2H2zm5 0h2v2H7zm5 0h2v2h-2z',
  agent: 'M5 2h6v6H5zm2 2v2h2V4zM3 10h10v4h-2v-2H5v2H3z',
  attention: 'M7 1h2v9H7zm0 11h2v2H7z',
} as const;

export type DockIconName = keyof typeof paths;

export function DockIcon({ name }: { name: DockIconName }) {
  return (
    <svg
      width={DOCK_ICON_SIZE_PX}
      height={DOCK_ICON_SIZE_PX}
      viewBox={`0 0 ${DOCK_ICON_SIZE_PX} ${DOCK_ICON_SIZE_PX}`}
      fill="currentColor"
      fillRule="evenodd"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
