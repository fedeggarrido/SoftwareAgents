import assert from 'node:assert/strict';

import { afterEach, test, vi } from 'vitest';

import type { BoardState, ServerMessage } from '../../core/src/messages.js';
import {
  FALLBACK_FLOOR_COLOR,
  MAX_DELTA_TIME_SEC,
  TILE_SIZE,
  WALL_COLOR,
} from '../src/constants.js';
import { getCharacterSprite } from '../src/office/engine/characters.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { CharacterSprites } from '../src/office/sprites/spriteData.js';
import { clearAgentRole } from '../src/office/toolUtils.js';
import type { SpriteData } from '../src/office/types.js';
import { CharacterState, TileType } from '../src/office/types.js';

const harness = vi.hoisted(() => ({
  receive: (message: ServerMessage): void => {
    throw new Error(`message handler not registered for ${message.type}`);
  },
  cleanups: [] as Array<() => void>,
}));

// Run the real message handler without mounting React or the canvas renderer.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useCallback: <T>(callback: T) => callback,
  useRef: <T>(current: T) => ({ current }),
  useState: <T>(initial?: T) => [initial, vi.fn()],
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) harness.cleanups.push(cleanup);
  },
}));
vi.mock('../src/office/engine/renderer.js', () => ({ setGhostHeadlessAgents: vi.fn() }));
vi.mock('../src/transport/index.js', () => ({
  transport: {
    state: 'connected',
    send: vi.fn(),
    onMessage: (handler: (message: ServerMessage) => void) => {
      harness.receive = handler;
      return vi.fn();
    },
    onStateChange: () => vi.fn(),
  },
}));

afterEach(() => {
  for (const cleanup of harness.cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  clearAgentRole(1);
});

function board(status: string): BoardState {
  const quota = {
    status: 'unknown' as const,
    usedPercent: null,
    resetsAt: null,
    observedAt: null,
  };
  return {
    type: 'boardState',
    project: 'project',
    items: [],
    recent: [],
    sources: { board: false, claims: false, progress: false },
    quota: { claude: { ...quota, provider: 'claude' }, codex: { ...quota, provider: 'codex' } },
    gate: [],
    summary: { total: 0, byPhase: {}, byEpic: {} },
    waiting: [],
    decisions: [],
    meeting: {
      id: 'meeting',
      format: 'discussion',
      topic: 'QA',
      question: 'Next step?',
      participants: ['developer'],
      status,
      round: '1',
      lines: [],
    },
    generatedAt: 1,
  };
}

function meetingOffice(): OfficeState {
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
    sprites: Object.fromEntries(catalog.map(({ id }) => [id, [[WALL_COLOR]]])),
  });
  const areaTiles = Array<string | null>(7 * 5).fill(null);
  areaTiles[3 * 7 + 5] = 'Meeting';
  const os = new OfficeState({
    version: 1,
    cols: 7,
    rows: 5,
    tiles: Array(7 * 5).fill(TileType.FLOOR_1),
    furniture: [
      { uid: 'desk', type: 'WORK_CHAIR', col: 3, row: 2 },
      { uid: 'pc', type: 'PC', col: 3, row: 1 },
      { uid: 'meeting-chair', type: 'WORK_CHAIR', col: 5, row: 3 },
    ],
    areas: [{ label: 'Meeting', color: WALL_COLOR }],
    areaTiles,
  });
  os.addAgent(1, 0, 0, 'desk', true);
  os.setAgentActive(1, false);
  return os;
}

async function startMeeting(os: OfficeState): Promise<void> {
  const hookPath = '../src/hooks/useExtensionMessages.js';
  const { useExtensionMessages: registerMessages } = await import(hookPath);
  registerMessages(() => os);
  harness.receive({
    type: 'agentRole',
    id: 1,
    label: 'Developer',
    department: 'Engineering',
    detail: 'reuni\u00f3n meeting',
  });
  harness.receive(board('running'));
}

function simulate(os: OfficeState, seconds: number): void {
  for (let step = 0; step < Math.ceil(seconds / MAX_DELTA_TIME_SEC); step++) {
    os.update(MAX_DELTA_TIME_SEC);
  }
}

test.each([CharacterState.TYPE, CharacterState.IDLE, CharacterState.WALK])(
  'an inactive participant in %s reaches its meeting chair, stays still, and leaves when it ends',
  async (initialState) => {
    // Keep browser-only transitive imports out of the node TypeScript project.
    const hookPath = '../src/hooks/useExtensionMessages.js';
    const { useExtensionMessages } = await import(hookPath);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const still: SpriteData = [[WALL_COLOR]];
    const typing: SpriteData = [[FALLBACK_FLOOR_COLOR]];
    const walkFrames: [SpriteData, SpriteData, SpriteData, SpriteData] = [
      still,
      still,
      still,
      still,
    ];
    const typeFrames: [SpriteData, SpriteData] = [typing, typing];
    const sprites: CharacterSprites = {
      walk: { 0: walkFrames, 1: walkFrames, 2: walkFrames, 3: walkFrames },
      typing: { 0: typeFrames, 1: typeFrames, 2: typeFrames, 3: typeFrames },
      reading: { 0: typeFrames, 1: typeFrames, 2: typeFrames, 3: typeFrames },
    };
    const os = meetingOffice();
    const ch = os.characters.get(1)!;
    ch.state = initialState;
    if (initialState !== CharacterState.TYPE) {
      ch.seatTimer = 0;
      ch.tileCol = 1;
      ch.tileRow = 3;
      ch.x = ch.tileCol * TILE_SIZE + TILE_SIZE / 2;
      ch.y = ch.tileRow * TILE_SIZE + TILE_SIZE / 2;
    }
    if (initialState === CharacterState.WALK) ch.path = [{ col: 2, row: 3 }];
    useExtensionMessages(() => os);
    harness.receive({
      type: 'agentRole',
      id: 1,
      label: 'Developer',
      department: 'Engineering',
      detail: 'reunión meeting',
    });
    harness.receive(board('running'));

    assert.equal(ch.isInMeeting, true);
    assert.equal(ch.seatId, 'meeting-chair');
    assert.equal(ch.hasWorkstation, false);
    assert.equal(ch.state, CharacterState.WALK);
    assert.deepEqual(ch.path.at(-1), { col: 5, row: 3 });

    const simulate = (seconds: number, inspect?: () => void) => {
      for (let step = 0; step < Math.ceil(seconds / MAX_DELTA_TIME_SEC); step++) {
        os.update(MAX_DELTA_TIME_SEC);
        inspect?.();
      }
    };
    simulate(10);
    os.rebuildFromLayout(structuredClone(os.getLayout()));
    os.setAgentActive(1, false);
    simulate(30, () => {
      assert.equal(ch.isActive, false);
      assert.equal(ch.hasDomainWork, false);
      assert.equal(ch.state, CharacterState.TYPE);
      assert.deepEqual({ col: ch.tileCol, row: ch.tileRow }, { col: 5, row: 3 });
      assert.deepEqual(ch.path, []);
      assert.equal(getCharacterSprite(ch, sprites), still);
      assert.equal(ch.frame, 0);
    });

    harness.receive(board('finished'));
    assert.equal(ch.isInMeeting, false);
    assert.equal(ch.seatId, 'desk');
    assert.equal(ch.seatTimer, 0);
    assert.deepEqual(ch.path, []);
    simulate(10);
    assert.notEqual(ch.state, CharacterState.TYPE);
    assert.equal(os.getSeatAtTile(ch.tileCol, ch.tileRow), null);
  },
);

test.each([
  { original: 'taken', spare: true },
  { original: 'taken', spare: false },
  { original: 'none', spare: true },
  { original: 'none', spare: false },
])(
  'meeting cleanup releases its temporary seat when original=$original, spare=$spare',
  async ({ original, spare }) => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const os = meetingOffice();
    const layout = structuredClone(os.getLayout());
    // A plain chair must never be used as the cleanup fallback.
    layout.furniture.push({ uid: 'plain', type: 'WORK_CHAIR', col: 6, row: 0 });
    if (spare) {
      layout.furniture.push(
        { uid: 'spare', type: 'WORK_CHAIR', col: 1, row: 2 },
        { uid: 'spare-pc', type: 'PC', col: 1, row: 1 },
      );
    }
    os.rebuildFromLayout(layout);
    if (original === 'none') os.reassignSeat(1, null);
    await startMeeting(os);
    simulate(os, 10);
    const ch = os.characters.get(1)!;
    assert.equal(ch.seatId, 'meeting-chair');
    assert.equal(ch.state, CharacterState.TYPE);
    os.addAgent(2, 0, 0, 'desk', true);

    harness.receive(board('finished'));

    assert.equal(ch.isInMeeting, false);
    assert.equal(ch.seatId, spare ? 'spare' : null);
    assert.equal(ch.hasWorkstation, spare);
    assert.equal(os.seats.get('meeting-chair')!.assigned, false);
    assert.equal(os.characters.get(2)!.seatId, 'desk');
    assert.equal(os.seats.get('desk')!.assigned, true);
    assert.deepEqual(ch.path, []);
    assert.equal(ch.state, CharacterState.IDLE);
    assert.equal(ch.seatTimer, 0);
    assert.equal(os.getPersistableSeats()[1].seatId, spare ? 'spare' : null);
    simulate(os, 2);
    os.setAgentActive(1, true);
    simulate(os, 10);
    assert.equal(ch.seatId, spare ? 'spare' : null);
    assert.notDeepEqual({ col: ch.tileCol, row: ch.tileRow }, { col: 5, row: 3 });
    if (spare) {
      assert.deepEqual({ col: ch.tileCol, row: ch.tileRow }, { col: 1, row: 2 });
      assert.equal(ch.state, CharacterState.TYPE);
    }
  },
);

test('an active participant without a free workstation leaves the released meeting chair before working seatless', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const os = meetingOffice();
  await startMeeting(os);
  os.setAgentActive(1, true);
  simulate(os, 10);
  const ch = os.characters.get(1)!;
  assert.equal(ch.state, CharacterState.TYPE);
  assert.deepEqual({ col: ch.tileCol, row: ch.tileRow }, { col: 5, row: 3 });
  os.addAgent(2, 0, 0, 'desk', true);

  harness.receive(board('finished'));

  assert.equal(ch.isInMeeting, false);
  assert.equal(ch.seatId, null);
  assert.equal(ch.hasWorkstation, false);
  assert.equal(os.seats.get('meeting-chair')!.assigned, false);
  assert.equal(ch.state, CharacterState.WALK);
  assert.ok(ch.path.length > 0);
  assert.ok(ch.path.every(({ col, row }) => !os.blockedTiles.has(`${col},${row}`)));
  simulate(os, 10);
  assert.equal(ch.state, CharacterState.TYPE);
  assert.equal(os.getSeatAtTile(ch.tileCol, ch.tileRow), null);
  assert.ok(os.walkableTiles.some(({ col, row }) => col === ch.tileCol && row === ch.tileRow));

  // Another participant can use the released chair while the first keeps working.
  const next = os.characters.get(2)!;
  next.isInMeeting = true;
  os.reassignSeat(2, 'meeting-chair');
  simulate(os, 10);
  assert.equal(next.state, CharacterState.TYPE);
  assert.deepEqual({ col: next.tileCol, row: next.tileRow }, { col: 5, row: 3 });
  assert.notDeepEqual(
    { col: ch.tileCol, row: ch.tileRow },
    { col: next.tileCol, row: next.tileRow },
  );
  assert.equal(ch.state, CharacterState.TYPE);
});

test.each(['moved', 'removed'])(
  'layout rebuild reroutes an inactive participant when its meeting chair is %s',
  async (change) => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const os = meetingOffice();
    await startMeeting(os);
    simulate(os, 10);
    const ch = os.characters.get(1)!;
    assert.equal(ch.state, CharacterState.TYPE);
    assert.deepEqual({ col: ch.tileCol, row: ch.tileRow }, { col: 5, row: 3 });
    const layout = structuredClone(os.getLayout());
    if (change === 'moved') {
      layout.furniture.find((item) => item.uid === 'meeting-chair')!.col = 6;
      layout.areaTiles![3 * 7 + 6] = 'Meeting';
    } else {
      layout.furniture = layout.furniture.filter((item) => item.uid !== 'meeting-chair');
    }

    os.rebuildFromLayout(layout);

    const target = change === 'moved' ? { col: 6, row: 3 } : { col: 3, row: 2 };
    assert.equal(ch.isActive, false);
    assert.equal(ch.isInMeeting, true);
    assert.equal(ch.seatId, change === 'moved' ? 'meeting-chair' : 'desk');
    assert.equal(ch.state, CharacterState.WALK);
    assert.deepEqual(ch.path.at(-1), target);
    assert.equal(ch.moveProgress, 0);
    assert.equal(ch.seatTimer, 0);
    simulate(os, 10);
    assert.equal(ch.state, CharacterState.TYPE);
    assert.deepEqual({ col: ch.tileCol, row: ch.tileRow }, target);
  },
);
