import { Parser } from '@asyncapi/parser';
import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { roleMessage } from '../src/agentRoles.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { BoardWatcher } from '../src/boardWatcher.js';

vi.mock('../src/quotaReader.js', () => {
  const quota = (provider: string) => ({
    provider,
    status: 'unknown',
    usedPercent: null,
    resetsAt: null,
    observedAt: null,
  });
  return { claudeQuota: () => quota('claude'), codexQuota: () => quota('codex') };
});
vi.mock('../src/companyControl.js', () => ({ readAutopilot: () => undefined }));

const server = Fastify({ ajv: { customOptions: { strict: false, removeAdditional: false } } });

beforeAll(async () => {
  const { document } = await new Parser().parse(
    fs.readFileSync(path.join(__dirname, '../../core/asyncapi.yaml'), 'utf-8'),
  );
  const body = document?.schemas().get('ServerMessage')?.json();
  if (!body) throw new Error('Missing ServerMessage schema');
  server.post('/validate', { schema: { body } }, async () => ({ ok: true }));
  await server.ready();
});
afterAll(() => server.close());

async function validate(message: unknown): Promise<boolean> {
  const response = await server.inject({
    method: 'POST',
    url: '/validate',
    payload: JSON.parse(JSON.stringify(message)),
  });
  return response.statusCode === 200;
}

describe('company server message contract', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-board-'));
    fs.mkdirSync(path.join(workspace, 'docs/backlog'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, 'docs/backlog/board.json'),
      JSON.stringify({ project: 'SoftwareAgents', items: [{ id: 'SA-005', title: 'Protocol' }] }),
    );
  });

  afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

  it('validates the emitted aggregate and suppresses timestamp-only broadcasts', async () => {
    const store = new AgentStateStore();
    const sent = vi.fn();
    store.on('broadcast', sent);
    let now = 1000;
    const watcher = new BoardWatcher(store, workspace, () => now);
    watcher.tick();
    const message = sent.mock.calls[0][0];
    expect(await validate(message)).toBe(true);
    expect(message.items[0]).toEqual({
      id: 'SA-005',
      title: 'Protocol',
      phase: 'ANALYSIS',
      owner: undefined,
      lastEvent: undefined,
      agentIds: [],
    });
    expect(message.sources).toEqual({ board: true, claims: false, progress: false });
    now = 2000;
    watcher.tick();
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('accepts all four variants and rejects extra top-level fields', async () => {
    const board = new BoardWatcher(new AgentStateStore(), workspace).build();
    const messages = [
      board,
      roleMessage(1, { label: 'DEV', department: 'Ingeniería', detail: 'tarea SA-005' }),
      { type: 'agentProviderLabel', id: 1, label: 'Codex' },
      { type: 'companyNotice', text: 'Ready' },
    ];
    for (const message of messages) {
      const wire = JSON.parse(JSON.stringify(message));
      expect(await validate(wire)).toBe(true);
      expect(await validate({ ...wire, unexpected: true })).toBe(false);
    }
  });
});
