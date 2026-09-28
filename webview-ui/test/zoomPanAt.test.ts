import assert from 'node:assert/strict';

import { test } from 'vitest';

import { zoomPanAt } from '../src/office/projection.js';

test('zoom keeps the world point under the pointer fixed', () => {
  const pan = { x: 120, y: -60 };
  const anchor = { x: 200, y: -100 };
  const next = zoomPanAt(pan, 4, 6, anchor);

  assert.equal((anchor.x - pan.x) / 4, (anchor.x - next.x) / 6);
  assert.equal((anchor.y - pan.y) / 4, (anchor.y - next.y) / 6);
});

test('zoom buttons keep the center point fixed', () => {
  assert.deepEqual(zoomPanAt({ x: 80, y: -40 }, 4, 2), { x: 40, y: -20 });
});
