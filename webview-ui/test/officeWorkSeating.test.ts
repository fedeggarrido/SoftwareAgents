import assert from 'node:assert/strict';

import { test } from 'vitest';

import { FALLBACK_FLOOR_COLOR, WALL_COLOR } from '../src/constants.js';
import { getCharacterSprite } from '../src/office/engine/characters.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { CharacterSprites } from '../src/office/sprites/spriteData.js';
import type { OfficeLayout, SpriteData } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

function office(): OfficeState {
  const catalog = [
    { id: 'SOFA_FRONT', category: 'chairs', orientation: 'front' },
    { id: 'WORK_CHAIR', category: 'chairs', orientation: 'back' },
    { id: 'PC_FRONT_OFF', category: 'electronics' },
  ].map((item) => ({
    label: item.id,
    width: 16,
    height: 16,
    footprintW: 1,
    footprintH: 1,
    isDesk: false,
    ...item,
  }));
  const sprites = Object.fromEntries(catalog.map(({ id }) => [id, [[WALL_COLOR]]]));
  buildDynamicCatalog({ catalog, sprites });

  const cols = 8;
  const rows = 5;
  const areaTiles = Array<string | null>(cols * rows).fill(null);
  areaTiles[2 * cols + 2] = 'Reuniones';
  const layout: OfficeLayout = {
    version: 1,
    cols,
    rows,
    tiles: Array(cols * rows).fill(TileType.FLOOR_1),
    furniture: [
      { uid: 'sofa', type: 'SOFA_FRONT', col: 1, row: 2 },
      { uid: 'meeting', type: 'WORK_CHAIR', col: 2, row: 2 },
      { uid: 'desk-a', type: 'WORK_CHAIR', col: 4, row: 2 },
      { uid: 'desk-b', type: 'WORK_CHAIR', col: 6, row: 2 },
      { uid: 'pc-a', type: 'PC_FRONT_OFF', col: 4, row: 1 },
      { uid: 'pc-b', type: 'PC_FRONT_OFF', col: 6, row: 1 },
    ],
    areas: [{ label: 'Reuniones', color: WALL_COLOR }],
    areaTiles,
  };
  return new OfficeState(layout);
}

test('restored workers leave sofa and meeting seats for available PCs', () => {
  const os = office();
  os.addAgent(1, 0, 0, 'sofa', true);
  os.addAgent(2, 0, 0, 'meeting', true);

  const assigned = [os.characters.get(1)!, os.characters.get(2)!];
  assert.deepEqual(new Set(assigned.map((ch) => ch.seatId)), new Set(['desk-a', 'desk-b']));
  assert.ok(assigned.every((ch) => ch.hasWorkstation));

  os.addAgent(3, 0, 0, 'sofa', true);
  assert.equal(os.characters.get(3)!.seatId, null);
  assert.equal(os.characters.get(3)!.hasWorkstation, false);
});

test('layout rebuild moves an existing lounge worker to a free desk', () => {
  const os = office();
  os.addAgent(1, 0, 0, 'sofa', true);
  os.reassignSeat(1, 'sofa');
  assert.equal(os.characters.get(1)!.seatId, 'sofa');

  os.rebuildFromLayout(os.getLayout());
  assert.ok(['desk-a', 'desk-b'].includes(os.characters.get(1)!.seatId ?? ''));
  assert.equal(os.characters.get(1)!.hasWorkstation, true);
});

test('a worker without a PC and a meeting participant use a still pose', () => {
  const os = office();
  os.addAgent(1, 0, 0, 'sofa', true);
  os.addAgent(2, 0, 0, 'meeting', true);
  os.addAgent(3, 0, 0, 'sofa', true);
  const still: SpriteData = [[WALL_COLOR]];
  const typing: SpriteData = [[FALLBACK_FLOOR_COLOR]];
  const walkFrames: [SpriteData, SpriteData, SpriteData, SpriteData] = [still, still, still, still];
  const typeFrames: [SpriteData, SpriteData] = [typing, typing];
  const sprites: CharacterSprites = {
    walk: { 0: walkFrames, 1: walkFrames, 2: walkFrames, 3: walkFrames },
    typing: { 0: typeFrames, 1: typeFrames, 2: typeFrames, 3: typeFrames },
    reading: { 0: typeFrames, 1: typeFrames, 2: typeFrames, 3: typeFrames },
  };

  assert.equal(getCharacterSprite(os.characters.get(3)!, sprites), still);
  const participant = os.characters.get(1)!;
  participant.isInMeeting = true;
  assert.equal(getCharacterSprite(participant, sprites), still);
});
