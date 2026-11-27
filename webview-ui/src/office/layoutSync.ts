import { transport } from '../transport/index.js';
import type { OfficeLayout } from './types.js';

/**
 * SA-162: every save carries the saved-layout revision this tab edits from, so a
 * stale save (queued offline, or from a tab that missed another's save) cannot
 * silently replace a newer layout: the server answers `layoutConflict` instead.
 * One save is in flight at a time, so a tab never collides with its own save.
 */
const sync = {
  base: undefined as string | undefined,
  /** A newer layout the owner chose to overwrite; its pending reload is stale. */
  overwritten: undefined as string | undefined,
  inFlight: false,
  next: null as OfficeLayout | null,
};

function send(layout: OfficeLayout): void {
  sync.inFlight = true;
  transport.send({
    type: 'saveLayout',
    // The protocol keeps layouts opaque; a shallow copy is a plain record.
    layout: { ...layout },
    baseRevision: sync.base,
  });
}

function settle(): void {
  sync.inFlight = false;
  const next = sync.next;
  sync.next = null;
  if (next) send(next);
}

export function sendLayoutSave(layout: OfficeLayout): void {
  if (sync.inFlight) sync.next = layout;
  else send(layout);
}

/** A (re)load from the office. It also ends a save whose reply a dropped connection lost. */
export function layoutLoaded(revision: string | undefined, dirty: boolean): void {
  // A load skipped for unsaved edits keeps the old base, so their save collides.
  if (!dirty && !isOverwrittenLayout(revision)) sync.base = revision;
  if (sync.inFlight) settle();
}

export function layoutSaved(revision: string): void {
  sync.base = revision;
  sync.overwritten = undefined;
  settle();
}

/** The save collided with `revision`; later edits are decided by the owner's answer. */
export function layoutConflicted(revision: string, keep: OfficeLayout | null): void {
  sync.inFlight = false;
  sync.next = null;
  sync.base = revision;
  if (!keep) return;
  sync.overwritten = revision;
  send(keep);
}

/** A reload of a layout the owner already chose to overwrite must not replace theirs. */
export function isOverwrittenLayout(revision: string | undefined): boolean {
  return revision !== undefined && revision === sync.overwritten;
}
