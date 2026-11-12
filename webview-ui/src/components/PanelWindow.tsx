import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { useRef } from 'react';

import {
  PANEL_TABS,
  PANEL_WINDOW_MOVE_STEP_PX,
  PANEL_WINDOW_RESIZE_STEP_PX,
  PANEL_WINDOW_TITLE_HEIGHT_PX,
  PANEL_WINDOW_Z_INDEX,
} from '../constants.js';
import { useDismissibleLayer } from '../hooks/useDismissibleLayer.js';
import type { PanelRect, PanelTab } from '../office/panelWindowState.js';
import { resizePanelRect } from '../office/panelWindowState.js';
import { Button } from './ui/Button.js';

interface PanelWindowProps {
  isOpen: boolean;
  tab: PanelTab;
  rect: PanelRect | null;
  mobile: boolean;
  onRectChange: (rect: PanelRect) => void;
  onReset: () => void;
  onClose: () => void;
  children: ReactNode;
}

export function PanelWindow({
  isOpen,
  tab,
  rect,
  mobile,
  onRectChange,
  onReset,
  onClose,
  children,
}: PanelWindowProps) {
  const label = PANEL_TABS.find((entry) => entry.id === tab)?.label;
  const titleRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLElement>(null);
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    rect: PanelRect;
    edge: string;
  } | null>(null);
  useDismissibleLayer(isOpen, onClose, PANEL_WINDOW_Z_INDEX, titleRef, false, windowRef);

  const start = (event: PointerEvent<HTMLElement>, edge = '') => {
    if (gesture.current || mobile || !rect || event.button !== 0) return;
    if (!edge && (event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      rect,
      edge,
    };
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId || mobile) return;
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    const next = { ...active.rect };
    if (!active.edge) {
      next.x += dx;
      next.y += dy;
    }
    onRectChange(active.edge ? resizePanelRect(active.rect, active.edge, dx, dy) : next);
  };
  const end = (event: PointerEvent<HTMLElement>) => {
    if (gesture.current?.pointerId === event.pointerId) gesture.current = null;
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || mobile || !rect) return;
    const directions: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    const [dx, dy] = direction;
    onRectChange(
      event.shiftKey
        ? {
            ...rect,
            width: rect.width + dx * PANEL_WINDOW_RESIZE_STEP_PX,
            height: rect.height + dy * PANEL_WINDOW_RESIZE_STEP_PX,
          }
        : {
            ...rect,
            x: rect.x + dx * PANEL_WINDOW_MOVE_STEP_PX,
            y: rect.y + dy * PANEL_WINDOW_MOVE_STEP_PX,
          },
    );
  };

  const style = {
    ...(!mobile && rect
      ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
      : {}),
    zIndex: PANEL_WINDOW_Z_INDEX,
    '--panel-title-height': `${PANEL_WINDOW_TITLE_HEIGHT_PX}px`,
  } as CSSProperties;
  return (
    <section
      ref={windowRef}
      className={`panel-window pixel-panel ${mobile ? 'panel-window-mobile' : ''}`}
      style={style}
      role="region"
      aria-label="Panel de la oficina"
      data-testid="panel-window"
      hidden={!isOpen}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div
        ref={titleRef}
        className="panel-window-title"
        tabIndex={0}
        role="group"
        onKeyDown={keyboard}
        aria-label={
          mobile
            ? 'Ventana de la oficina'
            : 'Ventana de la oficina. Flechas para mover, Mayúsculas y flechas para redimensionar'
        }
        onPointerDown={(event) => start(event)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
      >
        <span className="min-w-0 flex-1">{label}</span>
        <Button size="sm" variant="ghost" onClick={onReset}>
          Restablecer posición
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Cerrar ventana">
          ✕
        </Button>
      </div>
      <div id="office-panel-content" data-panel={tab} className="panel-window-content" tabIndex={0}>
        {children}
      </div>
      {!mobile &&
        ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'].map((edge) => (
          <div
            key={edge}
            className={`panel-window-resize panel-window-resize-${edge}`}
            aria-hidden="true"
            onPointerDown={(event) => start(event, edge)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onLostPointerCapture={end}
          />
        ))}
    </section>
  );
}
