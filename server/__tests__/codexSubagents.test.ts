import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { codexSessionsDirectory, findSubagentRollout } from '../src/executors/codexSubagents.js';

vi.mock('fs', async (original) => ({ ...(await original<typeof import('fs')>()) }));

let root: string;
const pad = (n: number) => String(n).padStart(2, '0');
const today = (d = new Date()) =>
  path.join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
function rollout(name: string, meta: object, mtimeMs?: number): string {
  fs.mkdirSync(today(), { recursive: true });
  const file = path.join(today(), name);
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: meta }) + '\n');
  if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-subagents-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

it('finds a sub-agent rollout whose parent is our thread, and only that one', () => {
  const since = Date.now() - 1000;
  rollout('rollout-a-other.jsonl', { id: 'x', parent_thread_id: 'someone-else' });
  rollout('rollout-b-top.jsonl', { id: 'y' });
  const child = rollout('rollout-c-child.jsonl', { id: 'z', parent_thread_id: 'our-thread' });
  const seen = new Set<string>();
  expect(findSubagentRollout(root, 'our-thread', since, seen)).toEqual({
    status: 'found',
    file: child,
  });
  expect(seen.size).toBe(2); // the two non-matching headers are read once
  expect(findSubagentRollout(root, 'nobody', since, seen)).toEqual({ status: 'none' });
});

it('ignores rollouts older than the launch and missing day folders', () => {
  const since = Date.now();
  rollout('rollout-old.jsonl', { parent_thread_id: 'our-thread' }, since - 60_000);
  expect(findSubagentRollout(root, 'our-thread', since, new Set())).toEqual({ status: 'none' });
  expect(findSubagentRollout(path.join(root, 'absent'), 'our-thread', since, new Set())).toEqual({
    status: 'none',
  });
});

it('retries a header still being written instead of marking it seen', () => {
  fs.mkdirSync(today(), { recursive: true });
  const file = path.join(today(), 'rollout-partial.jsonl');
  fs.writeFileSync(file, '{"type":"session_meta","payload":{"id":"z"'); // no newline yet
  const seen = new Set<string>();
  expect(findSubagentRollout(root, 'our-thread', Date.now() - 1000, seen)).toMatchObject({
    status: 'inconclusive',
  });
  expect(seen.has(file)).toBe(false);
  fs.appendFileSync(file, ',"parent_thread_id":"our-thread"}}\n');
  expect(findSubagentRollout(root, 'our-thread', Date.now() - 1000, seen)).toEqual({
    status: 'found',
    file,
  });
});

it('resolves the sessions root from CODEX_HOME, falling back to ~/.codex', () => {
  expect(codexSessionsDirectory({ CODEX_HOME: 'relative' }, root)).toBe(
    path.join(root, 'relative', 'sessions'),
  );
  expect(codexSessionsDirectory({ CODEX_HOME: 'D:/codex-home' })).toBe(
    path.join('D:/codex-home', 'sessions'),
  );
  expect(codexSessionsDirectory({})).toBe(path.join(os.homedir(), '.codex', 'sessions'));
});

it.each(['EACCES', 'EPERM', 'EBUSY', 'EIO'])('retries an unreadable day (%s)', (code) => {
  const read = vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code });
  });
  const seen = new Set<string>();
  expect(findSubagentRollout(root, 'parent', Date.now() - 1000, seen)).toMatchObject({
    status: 'inconclusive',
  });
  read.mockRestore();
  expect(findSubagentRollout(root, 'parent', Date.now() - 1000, seen)).toEqual({ status: 'none' });
});

it('covers intermediate days, parses spaced JSON and the nested parent shape', () => {
  const since = new Date(2026, 9, 1, 12).getTime();
  const now = new Date(2026, 9, 3, 12).getTime();
  const day = today(new Date(2026, 9, 2, 12));
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, 'rollout-child.jsonl');
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        type: 'session_meta',
        payload: {
          source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
        },
      },
      null,
      0,
    ).replace(/:/g, ': ') + '\n',
  );
  expect(findSubagentRollout(root, 'parent', since, new Set(), now)).toEqual({
    status: 'found',
    file,
  });
});

it('does not treat a parent-id string inside instructions as metadata', () => {
  rollout('rollout-text.jsonl', { instructions: '"parent_thread_id":"parent"' });
  expect(findSubagentRollout(root, 'parent', Date.now() - 1000, new Set())).toEqual({
    status: 'none',
  });
});

it('keeps oversized and malformed headers inconclusive and uncached', () => {
  const file = rollout('rollout-long.jsonl', {
    instructions: 'x'.repeat(300_000),
    parent_thread_id: 'parent',
  });
  const seen = new Set<string>();
  expect(findSubagentRollout(root, 'parent', Date.now() - 1000, seen)).toMatchObject({
    status: 'inconclusive',
  });
  expect(seen.has(file)).toBe(false);
  fs.writeFileSync(file, 'invalid JSON\n');
  expect(findSubagentRollout(root, 'parent', Date.now() - 1000, seen)).toMatchObject({
    status: 'inconclusive',
  });
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'session_meta', payload: { parent_thread_id: 'parent' } }) + '\n',
  );
  expect(findSubagentRollout(root, 'parent', Date.now() - 1000, seen)).toEqual({
    status: 'found',
    file,
  });
});
