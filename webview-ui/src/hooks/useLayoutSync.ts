import { useEffect } from 'react';

import { es } from '../i18n/es.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { migrateLayoutColors } from '../office/layout/layoutSerializer.js';
import { layoutConflicted, layoutLoaded, layoutSaved } from '../office/layoutSync.js';
import type { OfficeLayout } from '../office/types.js';
import { transport } from '../transport/index.js';

interface LayoutSyncEditor {
  isDirty: () => boolean;
  setLastSavedLayout: (layout: OfficeLayout) => void;
  markClean: () => void;
  /** Drops an edit's debounced save, so a discarded layout is never sent later. */
  cancelPendingSave: () => void;
}

/**
 * SA-162: keeps the save base in step with the saved layout and, when a save
 * collides with a newer layout from another client, lets the owner choose.
 */
export function useLayoutSync(
  getOfficeState: () => OfficeState,
  { isDirty, setLastSavedLayout, markClean, cancelPendingSave }: LayoutSyncEditor,
): void {
  useEffect(
    () =>
      transport.onMessage((msg) => {
        switch (msg.type) {
          case 'layoutLoaded':
            layoutLoaded(msg.revision, isDirty());
            return;
          case 'layoutSaved':
            layoutSaved(msg.revision);
            return;
          case 'layoutConflict': {
            const os = getOfficeState();
            if (window.confirm(es.office.layoutConflict)) {
              layoutConflicted(msg.revision, os.getLayout());
              return;
            }
            cancelPendingSave();
            layoutConflicted(msg.revision, null);
            // SAFETY: the server only stores layouts this UI saved (OfficeLayout v1).
            const saved = migrateLayoutColors(msg.layout as OfficeLayout);
            os.rebuildFromLayout(saved);
            setLastSavedLayout(saved);
            markClean();
            return;
          }
        }
      }),
    [getOfficeState, isDirty, setLastSavedLayout, markClean, cancelPendingSave],
  );
}
