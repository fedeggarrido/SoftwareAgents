import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SaveLayout } from '../../core/src/messages.js';
import { createLayoutSync } from '../src/office/layoutSync.js';
import type { OfficeLayout } from '../src/office/types.js';

const layout = (cols: number): OfficeLayout => ({
  version: 1,
  cols,
  rows: 1,
  tiles: [],
  furniture: [],
});
const send = vi.fn<(message: SaveLayout) => void>();
const bases = () => send.mock.calls.map(([message]) => message.baseRevision);

describe('SA-162 layout save sync', () => {
  let sync: ReturnType<typeof createLayoutSync>;
  beforeEach(() => {
    send.mockClear();
    sync = createLayoutSync(send);
    sync.loaded('r0', false);
  });

  it('keeps one save in flight, so a tab never collides with its own save', () => {
    sync.save(layout(1));
    sync.save(layout(2));
    sync.save(layout(3));
    expect(bases()).toEqual(['r0']);
    sync.saved('r1');
    expect(bases()).toEqual(['r0', 'r1']);
    expect(send.mock.calls[1][0].layout.cols).toBe(3);
  });

  it('drops queued edits on a conflict the owner resolves by loading the newer layout', () => {
    sync.save(layout(1));
    sync.save(layout(2));
    sync.conflicted('r9', null);
    expect(send).toHaveBeenCalledOnce();
    sync.save(layout(4));
    expect(bases()).toEqual(['r0', 'r9']);
  });

  it('overwrites on top of the newer revision and ignores its stale reload until saved', () => {
    sync.save(layout(1));
    sync.conflicted('r9', layout(1));
    expect(bases()).toEqual(['r0', 'r9']);
    expect(sync.isOverwritten('r9')).toBe(true);
    sync.saved('r10');
    expect(sync.isOverwritten('r9')).toBe(false);
  });

  it('keeps the old base when a reload is skipped for unsaved edits', () => {
    sync.loaded('r5', true);
    sync.save(layout(1));
    expect(bases()).toEqual(['r0']);
  });
});
