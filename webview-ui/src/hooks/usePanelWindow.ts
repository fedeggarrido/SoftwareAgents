import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { PANEL_MOBILE_BREAKPOINT_PX, PANEL_WINDOW_MARGIN_PX } from '../constants.js';
import { useBoard } from '../office/boardStore.js';
import type { PanelPreferences, PanelRect, PanelTab } from '../office/panelWindowState.js';
import {
  clampPanelRect,
  defaultPanelRect,
  readPanelPreferences,
  restorePanelRect,
  savePanelPreferences,
} from '../office/panelWindowState.js';

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

const occupiedSelectors = [
  '[data-testid="company-hud"]',
  '.office-notices',
  '[data-testid="zoom-controls"]',
  '.bottom-toolbar',
];

function occupiedBounds() {
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
  return { top, bottom };
}

function defaultRect() {
  const { top, bottom } = occupiedBounds();
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
  const meetingId = useBoard()?.meeting?.id;
  const previousMeeting = useRef<string | undefined>(undefined);
  const [meetingUnread, setMeetingUnread] = useState(false);

  useLayoutEffect(() => {
    if (!ready) return;
    const resize = () => {
      const nextMobile = window.innerWidth <= PANEL_MOBILE_BREAKPOINT_PX;
      setMobile(nextMobile);
      // Mobile is a sheet. Preserve desktop geometry for the next wide viewport.
      if (!nextMobile) {
        const { top, bottom } = occupiedBounds();
        setPreferences((current) => {
          const rect = current.rect
            ? restorePanelRect(current.rect, viewport(), top, bottom)
            : isOpen
              ? defaultRect()
              : null;
          if (JSON.stringify(rect) === JSON.stringify(current.rect)) return current;
          return { ...current, rect };
        });
      }
    };
    let observed: Element[] = [];
    const observer = new ResizeObserver(resize);
    const observeControls = () => {
      const controls = occupiedSelectors.flatMap((selector) => [
        ...document.querySelectorAll(selector),
      ]);
      if (controls.length === observed.length && controls.every((el, i) => el === observed[i]))
        return;
      observer.disconnect();
      observed = controls;
      for (const control of controls) observer.observe(control);
      resize();
    };
    // The HUD can arrive after layoutReady, or disappear when the project changes.
    const mutations = new MutationObserver(observeControls);
    mutations.observe(document.body, { childList: true, subtree: true });
    observeControls();
    resize();
    window.addEventListener('resize', resize);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [ready, isOpen]);

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
  useLayoutEffect(() => {
    if (!ready) return;
    if (meetingId && meetingId !== previousMeeting.current) {
      if (!isOpen) select('meeting');
      else if (preferences.lastTab !== 'meeting') setMeetingUnread(true);
    }
    previousMeeting.current = meetingId;
    if (isOpen && preferences.lastTab === 'meeting') setMeetingUnread(false);
  }, [ready, meetingId, isOpen, preferences.lastTab, select]);
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
    meetingUnread,
    toggle,
    select,
    setRect,
    reset,
    close: () => setIsOpen(false),
  };
}
