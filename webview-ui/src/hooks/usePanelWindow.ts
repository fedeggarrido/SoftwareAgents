import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

import { PANEL_MOBILE_BREAKPOINT_PX, PANEL_WINDOW_MARGIN_PX } from '../constants.js';
import type { PanelPreferences, PanelRect, PanelTab } from '../office/panelWindowState.js';
import {
  clampPanelRect,
  defaultPanelRect,
  readPanelPreferences,
  savePanelPreferences,
} from '../office/panelWindowState.js';

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

function defaultRect() {
  const bounds = [
    '[data-testid="company-hud"]',
    '.office-notices',
    '[data-testid="zoom-controls"]',
  ].flatMap((selector) => {
    const element = document.querySelector(selector);
    return element ? [element.getBoundingClientRect().bottom] : [];
  });
  const top = Math.max(0, ...bounds) + PANEL_WINDOW_MARGIN_PX;
  const bottom =
    (document.querySelector('.bottom-toolbar')?.getBoundingClientRect().top ?? window.innerHeight) -
    PANEL_WINDOW_MARGIN_PX;
  return defaultPanelRect(viewport(), top, bottom);
}

export function usePanelWindow(ready: boolean) {
  const [preferences, setPreferences] = useState<PanelPreferences>(() => {
    try {
      return readPanelPreferences(window.localStorage);
    } catch {
      return { rect: null, lastTab: 'backlog' };
    }
  });
  const [isOpen, setIsOpen] = useState(false);
  const [mobile, setMobile] = useState(() => window.innerWidth <= PANEL_MOBILE_BREAKPOINT_PX);

  useLayoutEffect(() => {
    if (!ready) return;
    const resize = () => {
      const nextMobile = window.innerWidth <= PANEL_MOBILE_BREAKPOINT_PX;
      setMobile(nextMobile);
      // Mobile is a sheet. Preserve desktop geometry for the next wide viewport.
      if (!nextMobile)
        setPreferences((current) => ({
          ...current,
          rect: current.rect ? clampPanelRect(current.rect, viewport()) : null,
        }));
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [ready]);

  useLayoutEffect(() => {
    if (ready && isOpen && !mobile && !preferences.rect) {
      setPreferences((current) => ({ ...current, rect: defaultRect() }));
    }
  }, [ready, isOpen, mobile, preferences.rect]);

  useEffect(() => {
    try {
      savePanelPreferences(window.localStorage, preferences);
    } catch {
      // Accessing localStorage itself can throw in a restricted webview.
    }
  }, [preferences]);

  const select = useCallback((tab: PanelTab) => {
    setPreferences((current) => ({ ...current, lastTab: tab }));
    setIsOpen(true);
  }, []);
  const toggle = (tab: PanelTab) => {
    if (isOpen && preferences.lastTab === tab) setIsOpen(false);
    else select(tab);
  };
  const setRect = (rect: PanelRect) =>
    setPreferences((current) => ({
      ...current,
      rect: clampPanelRect(rect, viewport()),
    }));
  const reset = () =>
    setPreferences((current) => ({ ...current, rect: mobile ? null : defaultRect() }));

  return {
    isOpen,
    tab: preferences.lastTab,
    rect: preferences.rect,
    mobile,
    toggle,
    select,
    setRect,
    reset,
    close: () => setIsOpen(false),
  };
}
