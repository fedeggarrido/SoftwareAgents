import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { codexSessionsDirectory, findSubagentRollout } from '../src/executors/codexSubagents.js';

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
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it('finds a sub-agent rollout whose parent is our thread, and only that one', () => {
  const since = Date.now() - 1000;
  rollout('rollout-a-other.jsonl', { id: 'x', parent_thread_id: 'someone-else' });
  rollout('rollout-b-top.jsonl', { id: 'y' });
  const child = rollout('rollout-c-child.jsonl', { id: 'z', parent_thread_id: 'our-thread' });
  const seen = new Set<string>();
  expect(findSubagentRollout(root, 'our-thread', since, seen)).toBe(child);
  expect(seen.size).toBe(2); // the two non-matching headers are read once
  expect(findSubagentRollout(root, 'nobody', since, seen)).toBeUndefined();
});

it('ignores rollouts older than the launch and missing day folders', () => {
  const since = Date.now();
  rollout('rollout-old.jsonl', { parent_thread_id: 'our-thread' }, since - 60_000);
  expect(findSubagentRollout(root, 'our-thread', since, new Set())).toBeUndefined();
  expect(findSubagentRollout(path.join(root, 'absent'), 'our-thread', since, new Set())).toBe(
    undefined,
  );
});

it('retries a header still being written instead of marking it seen', () => {
  fs.mkdirSync(today(), { recursive: true });
  const file = path.join(today(), 'rollout-partial.jsonl');
  fs.writeFileSync(file, '{"type":"session_meta","payload":{"id":"z"'); // no newline yet
  const seen = new Set<string>();
  expect(findSubagentRollout(root, 'our-thread', Date.now() - 1000, seen)).toBeUndefined();
  expect(seen.has(file)).toBe(false);
  fs.appendFileSync(file, ',"parent_thread_id":"our-thread"}}\n');
  expect(findSubagentRollout(root, 'our-thread', Date.now() - 1000, seen)).toBe(file);
});

it('resolves the sessions root from CODEX_HOME, falling back to ~/.codex', () => {
  expect(codexSessionsDirectory({ CODEX_HOME: 'D:/codex-home' })).toBe(
    path.join('D:/codex-home', 'sessions'),
  );
  expect(codexSessionsDirectory({})).toBe(path.join(os.homedir(), '.codex', 'sessions'));
});
