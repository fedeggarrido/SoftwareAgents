import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../src/transport/index.js', () => ({ transport: { send } }));

import type { OfficeLayout } from '../src/office/types.js';

const layout = (cols: number): OfficeLayout => ({ version: 1, cols, rows: 1, tiles: [], furniture: [] });
const bases = () => send.mock.calls.map(([msg]) => (msg as { baseRevision?: string }).baseRevision);

describe('SA-162 layout save sync', () => {
  let sync: typeof import('../src/office/layoutSync.js');
  beforeEach(async () => {
    vi.resetModules();
    send.mockClear();
    sync = await import('../src/office/layoutSync.js');
    sync.layoutLoaded('r0', false);
  });

  it('keeps one save in flight, so a tab never collides with its own save', () => {
    sync.sendLayoutSave(layout(1));
    sync.sendLayoutSave(layout(2));
    sync.sendLayoutSave(layout(3));
    expect(bases()).toEqual(['r0']);
    sync.layoutSaved('r1');
    expect(bases()).toEqual(['r0', 'r1']);
    expect(send.mock.calls[1][0].layout.cols).toBe(3);
  });

  it('drops queued edits on a conflict the owner resolves by loading the newer layout', () => {
    sync.sendLayoutSave(layout(1));
    sync.sendLayoutSave(layout(2));
    sync.layoutConflicted('r9', null);
    expect(send).toHaveBeenCalledOnce();
    sync.sendLayoutSave(layout(4));
    expect(bases()).toEqual(['r0', 'r9']);
  });

  it('overwrites on top of the newer revision and ignores its stale reload until saved', () => {
    sync.sendLayoutSave(layout(1));
    sync.layoutConflicted('r9', layout(1));
    expect(bases()).toEqual(['r0', 'r9']);
    expect(sync.isOverwrittenLayout('r9')).toBe(true);
    sync.layoutSaved('r10');
    expect(sync.isOverwrittenLayout('r9')).toBe(false);
  });

  it('keeps the old base when a reload is skipped for unsaved edits', () => {
    sync.layoutLoaded('r5', true);
    sync.sendLayoutSave(layout(1));
    expect(bases()).toEqual(['r0']);
  });
});
