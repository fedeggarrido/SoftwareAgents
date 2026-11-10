import { type RefObject, useLayoutEffect } from 'react';

import { officeHelpPlacement } from '../office/helpPlacement.js';

/** Keep help clear of the HUD, with scrolling in small viewports. */
export function useOfficeHelpPlacement(
  expanded: boolean,
  popupRef: RefObject<HTMLDivElement | null>,
) {
  useLayoutEffect(() => {
    const popup = popupRef.current;
    if (!expanded || !popup) return;
    const place = () => {
      const hud = document.querySelector('[data-testid="company-hud"]');
      const bounds = popup.getBoundingClientRect();
      const hudBounds = hud?.getBoundingClientRect();
      const overlapsHud =
        hudBounds && bounds.left < hudBounds.right && bounds.right > hudBounds.left;
      const naturalTop = bounds.top - (parseFloat(popup.style.marginTop) || 0);
      const placement = officeHelpPlacement(
        naturalTop,
        overlapsHud ? hudBounds.bottom : 0,
        window.innerHeight,
      );
      popup.style.marginTop = `${placement.marginTop}px`;
      popup.style.maxHeight = `${placement.maxHeight}px`;
    };
    const observer = new ResizeObserver(place);
    const observe = () => {
      observer.disconnect();
      const hud = document.querySelector('[data-testid="company-hud"]');
      if (hud) observer.observe(hud);
      if (popup.parentElement) observer.observe(popup.parentElement);
      place();
    };
    const mutations = new MutationObserver(observe);
    mutations.observe(document.body, { childList: true, subtree: true });
    observe();
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [expanded, popupRef]);
}
