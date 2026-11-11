import { readFileSync } from 'node:fs';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  PHASE_ORDER,
  STATUS_ICONS,
  STATUS_MAP,
  TEXT_SIZE_STORAGE_KEY,
  UI_LAYERS,
  WORK_STATE,
} from '../src/constants.js';
import {
  characterActivity,
  characterActivityLabel,
  characterDisplayName,
  shouldCharacterSit,
} from '../src/office/characterActivity.js';
import { createCharacter, getCharacterSprite } from '../src/office/engine/characters.js';
import type { CharacterSprites } from '../src/office/sprites/spriteData.js';
import { readableStateText, statusPresentation } from '../src/office/statusPresentation.js';
import { readTextSize, saveTextSize } from '../src/office/textSize.js';
import { spanishToolStatus } from '../src/office/toolUtils.js';
import type { SpriteData } from '../src/office/types.js';

it('orders every office layer below notices and modal dialogs', () => {
  expect(UI_LAYERS.office).toBeLessThan(UI_LAYERS.hud);
  expect(UI_LAYERS.hud).toBeLessThan(UI_LAYERS.panel);
  expect(UI_LAYERS.panel).toBeLessThan(UI_LAYERS.agentCard);
  expect(UI_LAYERS.agentCard).toBeLessThan(UI_LAYERS.notices);
  expect(UI_LAYERS.notices).toBeLessThan(UI_LAYERS.connection);
  expect(UI_LAYERS.connection).toBeLessThan(UI_LAYERS.modal);
  expect(UI_LAYERS.modal).toBeLessThan(UI_LAYERS.modalContent);
});

describe('one state for activity labels and character sprites', () => {
  const still: SpriteData = [['still']];
  const typing: SpriteData = [['typing']];
  const frames: CharacterSprites = {
    walk: {
      0: [still, still, still, still],
      1: [still, still, still, still],
      2: [still, still, still, still],
      3: [still, still, still, still],
    },
    typing: { 0: [typing, typing], 1: [typing, typing], 2: [typing, typing], 3: [typing, typing] },
    reading: { 0: [typing, typing], 1: [typing, typing], 2: [typing, typing], 3: [typing, typing] },
  };
  const tools = [{ toolId: 'tool', status: 'Reading archivo.ts', done: false }];
  it('keeps stale, unfinished tool rows from making an inactive character look busy', () => {
    const ch = createCharacter(1, 0, null, null);
    expect(characterActivityLabel(ch, tools)).toBe('Trabajando · Leyendo archivo.ts');
    expect(getCharacterSprite(ch, frames)).toBe(typing);
    ch.isActive = false;
    ch.waitingSince = 0;
    expect(characterActivity(ch)).toBe('waiting');
    expect(characterActivityLabel(ch, tools, 300_000)).toBe('En espera desde hace 5 min');
    expect(getCharacterSprite(ch, frames)).toBe(still);
  });
  it('keeps domain work active across turn gaps and rests while blocked', () => {
    const ch = createCharacter(1, 0, null, null);
    ch.isActive = false;
    ch.hasDomainWork = true;
    ch.workState = WORK_STATE.CODING;
    expect(characterActivityLabel(ch)).toBe('Trabajando');
    expect(getCharacterSprite(ch, frames)).toBe(typing);
    ch.workState = WORK_STATE.WAITING_QUOTA;
    expect(characterActivity(ch)).toBe('waiting');
    expect(shouldCharacterSit(ch)).toBe(false);
    expect(getCharacterSprite(ch, frames)).toBe(still);
  });
  it.each(['permission', 'domain'] as const)('rests and asks for approval from %s', (source) => {
    const ch = createCharacter(1, 0, null, null);
    if (source === 'permission') ch.bubbleType = 'permission';
    else ch.workState = WORK_STATE.WAITING_HUMAN;
    expect(characterActivity(ch)).toBe('needs_you');
    expect(characterActivityLabel(ch, tools)).toBe('Necesita tu aprobación');
    expect(getCharacterSprite(ch, frames)).toBe(still);
  });
});

it.each([
  ['Reading archivo.ts', 'Leyendo archivo.ts'],
  ['Editing archivo.ts', 'Editando archivo.ts'],
  ['Running: npm test', 'Ejecutando: npm test'],
  ['Searching the web', 'Buscando en la web'],
  ['Searching files', 'Buscando archivos'],
  ['Needs approval', 'Necesita tu aprobación'],
  ['Idle', 'En espera'],
])('translates activity %s without changing filenames or commands', (input, output) => {
  expect(spanishToolStatus(input)).toBe(output);
});

it('gives each task, work, feature and plan state a Spanish label and a pixel icon', async () => {
  for (const key of [
    ...PHASE_ORDER,
    ...Object.values(WORK_STATE),
    'in_review',
    'in_design',
    'in_development',
    'ready_to_merge',
    'merged',
    'approved',
    'changed',
    'unbound',
    'pending',
    'finished',
  ]) {
    const status = STATUS_MAP[key];
    expect(status, key).toBeDefined();
    expect(status.label).not.toMatch(/^[A-Z_]+$|unknown|desconocido/);
    expect(STATUS_ICONS[status.icon]).toBeTruthy();
  }
  expect(statusPresentation('FUTURE_INTERNAL_STATE')).toBe(STATUS_MAP.unknown);
  const modulePath = '../src/components/StatusChip.js';
  const { StatusChip } = await import(modulePath);
  const html = renderToStaticMarkup(createElement(StatusChip, { state: 'WAITING_HUMAN' }));
  expect(html).toContain('Esperando tu decisión');
  expect(html).toContain('<svg');
  expect(html).toContain('data-tone="attention"');
});

it('persists text size per viewer, ignores invalid values, and tolerates denied/full storage', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  expect(readTextSize(storage)).toBe('normal');
  saveTextSize('large', storage);
  expect(values.get(TEXT_SIZE_STORAGE_KEY)).toBe('large');
  expect(readTextSize(storage)).toBe('large');
  saveTextSize('normal', storage);
  expect(readTextSize(storage)).toBe('normal');
  values.set(TEXT_SIZE_STORAGE_KEY, 'invalid');
  expect(readTextSize(storage)).toBe('normal');
  const denied = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('full');
    },
  };
  expect(readTextSize(denied)).toBe('normal');
  expect(() => saveTextSize('large', denied)).not.toThrow();
  expect(readTextSize(undefined)).toBe('normal');
});

it('keeps reading text at 14–16 px and status/button text above AA contrast', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const shared = readFileSync(new URL('../src/ui.css', import.meta.url), 'utf8');
  expect(css).toContain('--reading-size: 14px');
  expect(shared).toContain('--reading-size: 16px');
  expect(css).not.toMatch(/@apply[^;]*font-pixel/);
  const color = (name: string) => css.match(new RegExp(`--color-${name}: #([0-9a-f]{6})`))![1];
  const luminance = (hex: string) => {
    const channels = hex.match(/../g)!.map((value) => {
      const channel = parseInt(value, 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  for (const name of [
    'status-active',
    'warning',
    'status-success',
    'error-border',
    'text-muted',
    'text',
  ]) {
    for (const background of ['bg', 'bg-dark']) {
      const ratio = (luminance(color(name)) + 0.05) / (luminance(color(background)) + 0.05);
      expect(ratio, `${name} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(
    (luminance(color('text')) + 0.05) / (luminance(color('accent')) + 0.05),
  ).toBeGreaterThanOrEqual(4.5);
});

it('keeps character names short and makes event transitions readable without UUIDs', () => {
  const ch = createCharacter(1, 0, null, null);
  expect(characterDisplayName(ch, 'Dueño', 'Claude')).toBe('Claude');
  ch.agentName = 'Ada';
  expect(characterDisplayName(ch, 'Dueño', 'Claude')).toBe('Ada');
  expect(readableStateText('WAITING_HUMAN → REVIEW · 3b547b5e-a1b2-4c3d-8e9f-123456789abc')).toBe(
    'Esperando tu decisión → En revisión ·',
  );
  ch.isInMeeting = true;
  expect(characterActivity(ch)).toBe('meeting');
  expect(characterActivityLabel(ch)).toBe('En reunión');
  ch.isActive = false;
  ch.bubbleType = 'permission';
  expect(shouldCharacterSit(ch)).toBe(true);
});
