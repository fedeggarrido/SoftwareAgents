import type { SaveLayout } from '../../../core/src/messages.js';
import type { OfficeLayout } from './types.js';

/**
 * SA-162: every save carries the saved-layout revision this tab edits from, so a
 * stale save (queued offline, or from a tab that missed another's save) cannot
 * silently replace a newer layout: the server answers `layoutConflict` instead.
 * One save is in flight at a time, so a tab never collides with its own save.
 */
export function createLayoutSync(post: (message: SaveLayout) => void) {
  let base: string | undefined;
  /** A newer layout the owner chose to overwrite; its pending reload is stale. */
  let overwritten: string | undefined;
  let inFlight = false;
  let next: OfficeLayout | null = null;

  const send = (layout: OfficeLayout) => {
    inFlight = true;
    // The protocol keeps layouts opaque; a shallow copy is a plain record.
    post({ type: 'saveLayout', layout: { ...layout }, baseRevision: base });
  };
  const settle = () => {
    inFlight = false;
    const queued = next;
    next = null;
    if (queued) send(queued);
  };
  const isOverwritten = (revision: string | undefined) =>
    revision !== undefined && revision === overwritten;

  return {
    save(layout: OfficeLayout): void {
      if (inFlight) next = layout;
      else send(layout);
    },
    /** A (re)load from the office. It also ends a save whose reply a dropped connection lost. */
    loaded(revision: string | undefined, dirty: boolean): void {
      // A load skipped for unsaved edits keeps the old base, so their save collides.
      if (!dirty && !isOverwritten(revision)) base = revision;
      if (inFlight) settle();
    },
    saved(revision: string): void {
      base = revision;
      overwritten = undefined;
      settle();
    },
    /** The save collided with `revision`; `keep` is this tab's layout when the owner keeps it. */
    conflicted(revision: string, keep: OfficeLayout | null): void {
      inFlight = false;
      next = null;
      base = revision;
      if (!keep) return;
      overwritten = revision;
      send(keep);
    },
    /** A reload of a layout the owner already chose to overwrite must not replace theirs. */
    isOverwritten,
  };
}
