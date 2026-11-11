import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import type { WorkSnapshot, WorkTaskStatus } from '../../core/src/messages.js';
import {
  FALLBACK_FLOOR_COLOR,
  INACTIVE_SEAT_TIMER_MIN_SEC,
  INACTIVE_SEAT_TIMER_RANGE_SEC,
  MAX_DELTA_TIME_SEC,
  TILE_SIZE,
  WALL_COLOR,
} from '../src/constants.js';
import { characterActivity, characterActivityLabel } from '../src/office/characterActivity.js';
import { getCharacterSprite } from '../src/office/engine/characters.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import * as tileMap from '../src/office/layout/tileMap.js';
import type { CharacterSprites } from '../src/office/sprites/spriteData.js';
import { clearAgentRole, setAgentRole, setProviderCapabilities } from '../src/office/toolUtils.js';
import type { Character, OfficeLayout, SpriteData } from '../src/office/types.js';
import { CharacterState, TileType } from '../src/office/types.js';

const still: SpriteData = [[WALL_COLOR]];
const typing: SpriteData = [[FALLBACK_FLOOR_COLOR]];
const reading: SpriteData = [[WALL_COLOR, FALLBACK_FLOOR_COLOR]];
const walkFrames: [SpriteData, SpriteData, SpriteData, SpriteData] = [still, still, still, still];
const typeFrames: [SpriteData, SpriteData] = [typing, typing];
const readFrames: [SpriteData, SpriteData] = [reading, reading];
const sprites: CharacterSprites = {
  walk: { 0: walkFrames, 1: walkFrames, 2: walkFrames, 3: walkFrames },
  typing: { 0: typeFrames, 1: typeFrames, 2: typeFrames, 3: typeFrames },
  reading: { 0: readFrames, 1: readFrames, 2: readFrames, 3: readFrames },
};

beforeEach(() => {
  // Repeatable varied destinations exercise many wander cycles, including routes
  // that would cross the character's own chair if it were left unblocked.
  let seed = 141;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  });
  setProviderCapabilities({ readingTools: ['Read'], subagentToolNames: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearAgentRole(1);
  setProviderCapabilities({ readingTools: [], subagentToolNames: [] });
});

function office(patch: Partial<OfficeLayout> = {}): OfficeState {
  const catalog = [
    { id: 'WORK_CHAIR', category: 'chairs', orientation: 'back' },
    { id: 'PC', category: 'electronics' },
  ].map((item) => ({
    label: item.id,
    width: TILE_SIZE,
    height: TILE_SIZE,
    footprintW: 1,
    footprintH: 1,
    isDesk: false,
    ...item,
  }));
  buildDynamicCatalog({
    catalog,
    sprites: Object.fromEntries(catalog.map(({ id }) => [id, still])),
  });
  const os = new OfficeState({
    version: 1,
    cols: 7,
    rows: 5,
    tiles: Array(7 * 5).fill(TileType.FLOOR_1),
    furniture: [
      { uid: 'desk', type: 'WORK_CHAIR', col: 3, row: 2 },
      { uid: 'pc', type: 'PC', col: 3, row: 1 },
      { uid: 'other', type: 'WORK_CHAIR', col: 5, row: 2 },
    ],
    ...patch,
  });
  os.addAgent(1, 0, 0, 'desk', true);
  return os;
}

function simulate(os: OfficeState, seconds: number, inspect?: () => void): void {
  for (let step = 0; step < Math.ceil(seconds / MAX_DELTA_TIME_SEC); step++) {
    os.update(MAX_DELTA_TIME_SEC);
    inspect?.();
  }
}

function atSeat(os: OfficeState, ch = os.characters.get(1)!): boolean {
  const seat = ch.seatId ? os.seats.get(ch.seatId) : undefined;
  return !!seat && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow;
}

function leaveSeat(os: OfficeState): Character {
  os.setAgentActive(1, false);
  simulate(os, INACTIVE_SEAT_TIMER_MIN_SEC + INACTIVE_SEAT_TIMER_RANGE_SEC + 1);
  const ch = os.characters.get(1)!;
  assert.equal(atSeat(os), false);
  return ch;
}

function workSnapshot(status: WorkTaskStatus): WorkSnapshot {
  return {
    type: 'workSnapshot',
    projectId: 'project',
    source: 'ok',
    lastEventId: 1,
    tasks: [
      {
        key: 'SA-141',
        type: 'IMPLEMENTATION',
        status,
        priority: 1,
        agentRole: 'developer',
        featureKey: null,
        version: 1,
        attempt: 1,
        dependsOn: [],
        updatedAt: 1,
      },
    ],
    decisions: [],
    generatedAt: 1,
  };
}

test('an inactive character wanders and pauses standing for 30 minutes without returning to any seat', () => {
  const os = office();
  const ch = leaveSeat(os);
  const states = new Set<string>();
  simulate(os, 30 * 60, () => {
    states.add(ch.state);
    assert.notEqual(ch.state, CharacterState.TYPE);
    assert.equal(atSeat(os), false);
    assert.equal(os.getSeatAtTile(ch.tileCol, ch.tileRow), null);
    assert.equal(getCharacterSprite(ch, sprites), still);
    for (const step of ch.path) assert.equal(os.getSeatAtTile(step.col, step.row), null);
  });
  assert.deepEqual(states, new Set([CharacterState.IDLE, CharacterState.WALK]));
  assert.equal(ch.seatId, 'desk');
  assert.equal(os.seats.get('desk')!.assigned, true);
  assert.equal(os.getPersistableSeats()[1].seatId, 'desk');
  os.addAgent(2, 0, 0, 'desk', true);
  assert.notEqual(os.characters.get(2)!.seatId, 'desk');
});

test.each([CharacterState.IDLE, CharacterState.WALK])(
  'work starting during %s sends the character back to its reserved seat and TYPE',
  (state) => {
    const os = office();
    const ch = leaveSeat(os);
    for (
      let step = 0;
      step < 1000 &&
      (ch.state !== state || (state === CharacterState.WALK && ch.path.length === 0));
      step++
    ) {
      os.update(MAX_DELTA_TIME_SEC);
    }
    assert.equal(ch.state, state);
    if (state === CharacterState.WALK) assert.ok(ch.path.length > 0);
    os.setAgentActive(1, true);
    os.update(MAX_DELTA_TIME_SEC);
    assert.equal(ch.state, CharacterState.WALK);
    const seat = os.seats.get(ch.seatId!)!;
    assert.deepEqual(ch.path.at(-1), { col: seat.seatCol, row: seat.seatRow });
    simulate(os, 10);
    assert.equal(atSeat(os), true);
    assert.equal(ch.state, CharacterState.TYPE);
    assert.equal(getCharacterSprite(ch, sprites), typing);
  },
);

test('brief gaps retain the seated position with a still pose and resume work without standing', () => {
  const os = office();
  const ch = os.characters.get(1)!;
  os.setAgentActive(1, false);
  const grace = ch.seatTimer;
  assert.ok(grace >= INACTIVE_SEAT_TIMER_MIN_SEC);
  assert.ok(grace <= INACTIVE_SEAT_TIMER_MIN_SEC + INACTIVE_SEAT_TIMER_RANGE_SEC);
  for (const tool of [null, 'Read']) {
    ch.currentTool = tool;
    simulate(os, 1, () => {
      assert.equal(ch.state, CharacterState.TYPE);
      assert.equal(atSeat(os), true);
      assert.equal(getCharacterSprite(ch, sprites), still);
    });
  }
  const remaining = ch.seatTimer;
  os.setAgentActive(1, false);
  assert.equal(ch.seatTimer, remaining, 'duplicate notifications do not restart the grace period');
  os.setAgentActive(1, true);
  simulate(os, 1);
  assert.equal(ch.state, CharacterState.TYPE);
  assert.equal(atSeat(os), true);
  assert.equal(ch.seatTimer, 0);
  assert.equal(getCharacterSprite(ch, sprites), reading);
});

test('replaying the layout during a tool gap preserves the remaining grace period and position', () => {
  const os = office();
  const ch = os.characters.get(1)!;
  os.setAgentActive(1, false);
  simulate(os, 1);
  const position = { col: ch.tileCol, row: ch.tileRow, x: ch.x, y: ch.y };

  for (let replay = 0; replay < 2; replay++) {
    const remaining = ch.seatTimer;
    assert.ok(remaining > 0);
    os.rebuildFromLayout(structuredClone(os.getLayout()));
    assert.equal(ch.seatTimer, remaining);
    assert.equal(ch.state, CharacterState.TYPE);
    assert.deepEqual({ col: ch.tileCol, row: ch.tileRow, x: ch.x, y: ch.y }, position);
    assert.equal(os.seats.get('desk')!.assigned, true);
    assert.equal(getCharacterSprite(ch, sprites), still);
    os.update(MAX_DELTA_TIME_SEC);
    assert.equal(ch.seatTimer, remaining - MAX_DELTA_TIME_SEC);
    assert.equal(atSeat(os), true);
  }

  simulate(os, ch.seatTimer + 1);
  assert.equal(ch.seatTimer, 0);
  assert.equal(atSeat(os), false);
  assert.notEqual(ch.state, CharacterState.TYPE);
});

test('leaving a seat in a large disconnected layout checks neighbours without pathfinding', () => {
  const cols = 80;
  const rows = 60;
  const tiles: OfficeLayout['tiles'] = Array(cols * rows).fill(TileType.FLOOR_1);
  // The first half of walkableTiles is unreachable from the character's room.
  for (let row = 0; row < rows; row++) tiles[row * cols + 40] = TileType.WALL;
  tiles[29 * cols + 60] = TileType.WALL;
  tiles[31 * cols + 60] = TileType.VOID;
  const os = office({
    cols,
    rows,
    tiles,
    furniture: [
      { uid: 'desk', type: 'WORK_CHAIR', col: 60, row: 30 },
      { uid: 'pc', type: 'PC', col: 59, row: 29 },
      { uid: 'other', type: 'WORK_CHAIR', col: 59, row: 30 },
    ],
  });
  const ch = os.characters.get(1)!;
  os.setAgentActive(1, false);
  ch.seatTimer = 0;
  ch.state = CharacterState.IDLE;
  // Avoid executing thousands of BFS traversals if this regression returns.
  const pathfinding = vi.spyOn(tileMap, 'findPath').mockReturnValue([]);

  os.update(MAX_DELTA_TIME_SEC);

  assert.equal(pathfinding.mock.calls.length, 0);
  assert.equal(ch.state, CharacterState.WALK);
  assert.deepEqual(ch.path, [{ col: 61, row: 30 }]);
});

test('seat departure chooses the open office south instead of the enclosed floor north', () => {
  const cols = 7;
  const rows = 5;
  const tiles: OfficeLayout['tiles'] = Array(cols * rows).fill(TileType.FLOOR_1);
  for (const [col, row] of [
    [3, 0],
    [2, 1],
    [4, 1],
    [2, 2],
    [4, 2],
  ]) {
    tiles[row * cols + col] = TileType.WALL;
  }
  const os = office({
    tiles,
    furniture: [
      { uid: 'desk', type: 'WORK_CHAIR', col: 3, row: 2 },
      { uid: 'pc', type: 'PC', col: 1, row: 0 },
    ],
  });
  const ch = os.characters.get(1)!;
  os.setAgentActive(1, false);
  ch.seatTimer = 0;
  ch.state = CharacterState.IDLE;
  const pathfinding = vi.spyOn(tileMap, 'findPath').mockReturnValue([]);
  const walkability = vi.spyOn(tileMap, 'isWalkable');

  os.update(MAX_DELTA_TIME_SEC);

  assert.deepEqual(ch.path, [{ col: 3, row: 3 }]);
  assert.equal(ch.state, CharacterState.WALK);
  assert.equal(pathfinding.mock.calls.length, 0);
  assert.ok(walkability.mock.calls.length <= 4 * cols * rows + 4);
});

test.each<WorkTaskStatus>(['RUNNING', 'WAITING_HUMAN'])(
  'domain work (%s) keeps an inactive session seated until its task finishes',
  (status) => {
    const os = office();
    setAgentRole(1, { label: 'Developer', department: 'Engineering', detail: 'tarea SA-141' });
    os.receiveWorkSnapshot(workSnapshot(status));
    os.setAgentActive(1, false);
    const ch = os.characters.get(1)!;
    simulate(os, 60, () => {
      assert.equal(ch.isActive, false);
      assert.equal(ch.hasDomainWork, true);
      assert.equal(ch.state, CharacterState.TYPE);
      assert.equal(atSeat(os), true);
    });
    os.receiveWorkSnapshot(workSnapshot('DONE'));
    simulate(os, INACTIVE_SEAT_TIMER_MIN_SEC + INACTIVE_SEAT_TIMER_RANGE_SEC + 1);
    assert.equal(ch.hasDomainWork, false);
    assert.notEqual(ch.state, CharacterState.TYPE);
    assert.equal(atSeat(os), false);
  },
);

test('domain work ending mid-return cancels the route into the reserved seat', () => {
  const os = office();
  const ch = leaveSeat(os);
  setAgentRole(1, { label: 'Developer', department: 'Engineering', detail: 'tarea SA-141' });
  os.receiveWorkSnapshot(workSnapshot('RUNNING'));
  os.update(MAX_DELTA_TIME_SEC);
  assert.equal(ch.state, CharacterState.WALK);
  assert.ok(ch.path.some((step) => step.col === 3 && step.row === 2));
  os.receiveWorkSnapshot(workSnapshot('DONE'));
  simulate(os, 60, () => {
    assert.notEqual(ch.state, CharacterState.TYPE);
    assert.equal(atSeat(os), false);
    assert.ok(ch.path.every((step) => step.col !== 3 || step.row !== 2));
  });
});

test('inactive seat commands and layout rebuilds preserve reservations without returning to a seat', () => {
  const os = office();
  const ch = leaveSeat(os);
  os.sendToSeat(1);
  assert.equal(os.walkToTile(1, 3, 2), false);
  assert.equal(atSeat(os), false);
  os.reassignSeat(1, 'other');
  assert.equal(ch.seatId, 'other');
  assert.equal(os.seats.get('desk')!.assigned, false);
  assert.equal(os.seats.get('other')!.assigned, true);
  assert.equal(ch.state, CharacterState.IDLE);
  assert.deepEqual(ch.path, []);
  os.rebuildFromLayout(os.getLayout());
  assert.equal(atSeat(os), false);
  assert.notEqual(ch.state, CharacterState.TYPE);
  assert.equal(os.seats.get(ch.seatId!)!.assigned, true);
});

test('permission requests retain activity and their persistent bubble, including while inactive', () => {
  const os = office();
  const ch = os.characters.get(1)!;
  os.showPermissionBubble(1);
  os.dismissBubble(1);
  assert.equal(characterActivity(ch), 'needs_you', 'selection does not approve a pending tool');
  assert.equal(characterActivityLabel(ch), 'Necesita tu aprobación');
  simulate(os, 60);
  assert.equal(ch.isActive, true);
  assert.equal(ch.state, CharacterState.TYPE);
  assert.equal(atSeat(os), true);
  assert.equal(ch.bubbleType, 'permission');
  leaveSeat(os);
  simulate(os, 60);
  assert.equal(ch.isActive, false);
  assert.equal(ch.bubbleType, 'permission');
  assert.equal(atSeat(os), false);
  os.clearPermissionBubble(1);
  assert.equal(ch.bubbleType, null);
});

test.each(['empty', 'sealed seat', 'disconnected floor'])(
  'an inactive character remains standing without crashing when there is no reachable destination (%s)',
  (kind) => {
    const tiles: OfficeLayout['tiles'] = Array(7 * 5).fill(TileType.WALL);
    const furniture: OfficeLayout['furniture'] = [];
    if (kind !== 'empty') {
      tiles[2 * 7 + 3] = TileType.FLOOR_1;
      furniture.push({ uid: 'desk', type: 'WORK_CHAIR', col: 3, row: 2 });
    }
    if (kind === 'disconnected floor') tiles[0] = TileType.FLOOR_1;
    const os = office({ tiles, furniture });
    os.setAgentActive(1, false);
    simulate(os, 60);
    const ch = os.characters.get(1)!;
    assert.equal(ch.state, CharacterState.IDLE);
    assert.deepEqual(ch.path, []);
    assert.equal(getCharacterSprite(ch, sprites), still);
    assert.ok(Number.isFinite(ch.x) && Number.isFinite(ch.y));
  },
);

test('resuming a turn clears the old input-wait signal and restores matching work animation', () => {
  const os = office();
  const ch = os.characters.get(1)!;
  os.setAgentActive(1, false);
  os.showWaitingBubble(1, true);
  simulate(os, 6);
  assert.equal(ch.bubbleType, null, 'the temporary checkmark has faded');
  assert.equal(characterActivityLabel(ch), 'Esperando tu respuesta');
  os.setAgentActive(1, true);
  simulate(os, 6);
  assert.equal(ch.waitingAwaitingInput, false);
  assert.equal(characterActivity(ch), 'working');
  assert.equal(characterActivityLabel(ch), 'Trabajando');
  assert.equal(getCharacterSprite(ch, sprites), typing);
});
