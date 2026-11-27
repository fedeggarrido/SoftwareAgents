import { useEffect } from 'react';

import { es } from '../i18n/es.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { migrateLayoutColors } from '../office/layout/layoutSerializer.js';
import { createLayoutSync } from '../office/layoutSync.js';
import type { OfficeLayout } from '../office/types.js';
import { transport } from '../transport/index.js';

/** The tab's one save channel (SA-162); every layout save goes through it. */
export const layoutSync = createLayoutSync((message) => transport.send(message));

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
            layoutSync.loaded(msg.revision, isDirty());
            return;
          case 'layoutSaved':
            layoutSync.saved(msg.revision);
            return;
          case 'layoutConflict': {
            const os = getOfficeState();
            if (window.confirm(es.office.layoutConflict)) {
              layoutSync.conflicted(msg.revision, os.getLayout());
              return;
            }
            cancelPendingSave();
            layoutSync.conflicted(msg.revision, null);
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
