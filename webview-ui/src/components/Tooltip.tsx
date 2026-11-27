import type { ReactNode } from 'react';

import { es } from '../i18n/es.js';

interface TooltipProps {
  title: string;
  onDismiss: () => void;
  position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'stack';
  children: ReactNode;
}

const positionStyles: Record<string, React.CSSProperties> = {
  'top-right': { top: 8, right: 52 },
  'top-left': { top: 8, left: 8 },
  'bottom-right': { bottom: 8, right: 52 },
  'bottom-left': { bottom: 8, left: 8 },
};

export function Tooltip({ title, onDismiss, position = 'top-right', children }: TooltipProps) {
  return (
    <div
      className={`${position === 'stack' ? 'relative max-w-full' : 'absolute layer-notices whitespace-nowrap'} pixel-panel p-0`}
      style={positionStyles[position]}
    >
      <div className="flex items-center justify-between py-4 px-8 border-b border-border">
        <span className="text-base text-accent-bright font-bold">{title}</span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={es.common.dismissNotice}
          className="tooltip-dismiss bg-transparent border-none text-text-muted cursor-pointer"
        >
          ✕
        </button>
      </div>
      <div className="py-6 px-8">{children}</div>
    </div>
  );
}
