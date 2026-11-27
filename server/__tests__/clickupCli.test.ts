import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { runClickUpCommand } from '../src/commands/clickup.js';
import type { ClickUpClient } from '../src/integrations/clickup/client.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';

vi.setConfig({ testTimeout: 90_000 });
vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => process.env.HOME ?? actual.homedir()) };
});

let root: string;
let repo: string;
const statuses = {
  READY: 'to do',
  IN_PROGRESS: 'in progress',
  REVIEW: 'review',
  QA: 'qa',
  BLOCKED: 'blocked',
  DONE: 'complete',
};

function operator(policy: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(root, '.pixel-agents/config.json'),
    JSON.stringify({ projects: { test: { allowedExecutors: [], ...policy } } }),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clickup-cli-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.softwareagents/brain'), { recursive: true });
  fs.mkdirSync(path.join(root, '.pixel-agents'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('CLICKUP_TOKEN', undefined);
  for (const key of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(key, undefined);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, windowsHide: true });
  fs.writeFileSync(
    path.join(repo, '.softwareagents/project.yaml'),
    'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: test\nname: Test\nrepo:\n  remote: https://example.invalid/test.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\nclickup:\n  workspaceId: w\n  folderId: f\n  listIds: [list-1]\n',
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it('is off unless the Operator opts the Project in, and then needs a token', async () => {
  operator({ autonomyLevel: 'A3' });
  await expect(runClickUpCommand(['sync'], repo, () => {})).rejects.toThrow('desactivado');
  operator({ autonomyLevel: 'A3', clickupMirror: { enabled: true, statuses } });
  await expect(runClickUpCommand(['sync'], repo, () => {})).rejects.toThrow('Falta el token');
  await expect(runClickUpCommand(['sync', '--force'], repo, () => {})).rejects.toThrow('Usage');
});

it('rejects an incomplete status map in the Operator config', async () => {
  operator({ autonomyLevel: 'A3', clickupMirror: { enabled: true, statuses: { READY: 'x' } } });
  await expect(runClickUpCommand(['sync'], repo, () => {})).rejects.toThrow();
});

it('mirrors the bound Project and audits the correction', async () => {
  operator({ autonomyLevel: 'A3', clickupMirror: { enabled: true, statuses } });
  const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
  store.createTask({ key: 'T-1', type: 'code', status: 'READY' });
  store.close();
  const writes: string[] = [];
  const client: ClickUpClient = {
    listTasks: async () => [{ id: 'c1', name: 'T-1 · algo', status: 'complete', customId: null }],
    setStatus: async (id, status) => void writes.push(`${id}=${status}`),
    comments: async () => [],
    comment: async () => {},
  };
  const lines: string[] = [];
  await runClickUpCommand(['sync'], repo, (line) => lines.push(line), client);
  expect(writes).toEqual(['c1=to do']);
  expect(lines).toEqual(['T-1: estado complete → to do']);
  const audit = fs.readFileSync(path.join(root, '.pixel-agents/audit/test.jsonl'), 'utf8');
  expect(audit).toContain('"action":"clickup_status"');
  expect(audit).toContain('"status":"drift"');
});
