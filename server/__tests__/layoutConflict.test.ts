import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Isolated home: os.homedir() is mocked so the real ~/.pixel-agents is never touched.
let tempHome: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tempHome };
});

import {
  layoutRevision,
  readLayoutFromFile,
  saveLayoutIfCurrent,
  writeLayoutToFile,
} from '../src/layoutPersistence.js';

const older = { version: 1, cols: 2, rows: 2, tiles: [0, 0, 0, 0], furniture: [] };
const newer = { ...older, tiles: [1, 1, 1, 1] };

describe('SA-162 layout save conflicts', () => {
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-layout-'));
  });
  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('allows a save made from the saved revision', () => {
    writeLayoutToFile(older);
    expect(saveLayoutIfCurrent(newer, layoutRevision(older))).toEqual({
      type: 'layoutSaved',
      revision: layoutRevision(newer),
    });
    expect(readLayoutFromFile()).toEqual(newer);
  });

  it('refuses a save whose base was replaced by another client, returning the newer layout', () => {
    writeLayoutToFile(older);
    const base = layoutRevision(older);
    writeLayoutToFile(newer); // another tab saved meanwhile
    expect(saveLayoutIfCurrent(older, base)).toEqual({
      type: 'layoutConflict',
      layout: newer,
      revision: layoutRevision(newer),
    });
    expect(readLayoutFromFile()).toEqual(newer);
  });

  it('keeps last-write-wins for clients that send no base, and when nothing is saved yet', () => {
    const onWrite = vi.fn();
    expect(saveLayoutIfCurrent(older, 'anything', onWrite).type).toBe('layoutSaved');
    expect(onWrite).toHaveBeenCalledOnce();
    writeLayoutToFile(newer);
    expect(saveLayoutIfCurrent(older, undefined).type).toBe('layoutSaved');
    expect(readLayoutFromFile()).toEqual(older);
  });

  it('gives equal layouts equal revisions', () => {
    expect(layoutRevision({ ...older })).toBe(layoutRevision(older));
    expect(layoutRevision(newer)).not.toBe(layoutRevision(older));
  });
});
