import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { AgentStateStore } from '../src/agentStateStore.js';
import * as auditLog from '../src/auditLog.js';
import * as auditView from '../src/auditView.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { configureCompanyControl } from '../src/companyControl.js';
import { readConfig, writeConfig } from '../src/configPersistence.js';
import { PixelAgentsServer } from '../src/server.js';

let testHome: string;
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => testHome ?? actual.homedir() };
});

afterEach(() => vi.restoreAllMocks());

it.each([
  {},
  { projectId: 'test' },
  { projectId: null, requestId: 'r1' },
  { projectId: 'test', requestId: 1 },
])('ignores malformed audit requests: %j', (fields) => {
  const read = vi.spyOn(auditView, 'readAuditView');
  const send = vi.fn();
  const store = new AgentStateStore();
  try {
    handleClientMessage({ type: 'requestAuditLog', ...fields }, send, {
      store,
      cache: null,
      privileged: true,
    });
    expect(send).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  } finally {
    store.dispose();
  }
});

// AC-016: denying a read must neither reveal counts nor append an audit entry.
it.each([false, undefined])('denies audit reads with privilege %s', (privileged) => {
  const read = vi.spyOn(auditView, 'readAuditView');
  const record = vi.spyOn(auditLog, 'recordAudit');
  const send = vi.fn();
  const store = new AgentStateStore();
  try {
    handleClientMessage(
      { type: 'requestAuditLog', projectId: 'test', requestId: 'request-1' },
      send,
      { store, cache: null, privileged },
    );
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: 'auditLog',
      projectId: 'test',
      requestId: 'request-1',
      status: 'denied',
      entries: [],
      totalValid: 0,
      truncated: false,
      corruptLines: [],
      excludedCount: 0,
    });
    expect(read).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  } finally {
    store.dispose();
  }
});

describe('audit WebSocket contract (AC-008, AC-011, AC-013, AC-015, AC-016)', () => {
  let server: PixelAgentsServer;
  let store: AgentStateStore;
  const sockets: WebSocket[] = [];
  let projectFile: string;
  let machineFile: string;
  let projectText: string;
  const machineText = 'machine sentinel\n';

  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(process.cwd(), '.audit-ws-test-'));
    const workspace = path.join(testHome, 'workspace');
    fs.mkdirSync(path.join(workspace, '.softwareagents'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.softwareagents/project.yaml'),
      'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: test\nname: Test\nrepo:\n  remote: https://example.invalid/test.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n',
    );
    configureCompanyControl(workspace);
    const config = readConfig();
    config.projects.test = { autonomyLevel: 'A1', allowedExecutors: ['codex'] };
    writeConfig(config);
    const entry: auditLog.AuditEntry = {
      id: 'fixture',
      occurredAt: '2026-10-16T10:00:05Z',
      projectId: 'test',
      actorType: 'human',
      actorId: null,
      action: 'fixture_read',
      resourceType: 'task',
      resourceId: null,
      policyDecision: null,
      riskLevel: 'low',
      inputHash: 'hidden',
      outcome: { status: 'ok', reason: 'fixture reason' },
      taskKey: null,
      executionId: null,
    };
    const log = new auditLog.AuditLog();
    projectFile = log.file('test');
    machineFile = log.file(null);
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    projectText = [entry, { ...entry, projectId: 'other' }, { ...entry, projectId: null }]
      .map((value) => JSON.stringify(value) + '\n')
      .join('');
    fs.writeFileSync(projectFile, projectText);
    fs.writeFileSync(machineFile, machineText);
    store = new AgentStateStore();
    server = new PixelAgentsServer();
  });

  afterEach(() => {
    for (const socket of sockets) socket.terminate();
    sockets.length = 0;
    server.stop();
    store.dispose();
    const target = path.resolve(testHome);
    if (
      path.dirname(target) !== process.cwd() ||
      !path.basename(target).startsWith('.audit-ws-test-')
    )
      throw new Error('Unexpected test directory');
    fs.rmSync(target, { recursive: true, force: true });
  });

  async function connect(embedded: boolean, tokened = false): Promise<WebSocket> {
    const config = await server.start({ embedded, store });
    const suffix = tokened ? `?token=${encodeURIComponent(config.token)}` : '';
    const socket = new WebSocket(`ws://127.0.0.1:${config.port.toString()}/ws${suffix}`, {
      headers: embedded ? { Authorization: `Bearer ${config.token}` } : {},
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return socket;
  }

  async function request(socket: WebSocket, projectId = 'test', requestId = 'r1') {
    const messages: Record<string, unknown>[] = [];
    const listener = (data: Buffer) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === 'auditLog') messages.push(message);
    };
    socket.on('message', listener);
    try {
      socket.send(JSON.stringify({ type: 'requestAuditLog', projectId, requestId }));
      await vi.waitFor(() => expect(messages).toHaveLength(1));
      return messages[0];
    } finally {
      socket.off('message', listener);
    }
  }

  function expectUnchanged() {
    expect(fs.readFileSync(projectFile, 'utf8')).toBe(projectText);
    expect(fs.readFileSync(machineFile, 'utf8')).toBe(machineText);
  }

  it.each([false, true])(
    'returns Project data to authorized clients, embedded=%s',
    async (embedded) => {
      const socket = await connect(embedded, !embedded);
      const snapshot = await request(socket);
      expect(snapshot).toMatchObject({
        type: 'auditLog',
        projectId: 'test',
        requestId: 'r1',
        status: 'ok',
        totalValid: 1,
        excludedCount: 2,
        truncated: false,
        corruptLines: [],
      });
      expect(snapshot.entries).toEqual([expect.objectContaining({ action: 'fixture_read' })]);
      expect(JSON.stringify(snapshot)).not.toContain('inputHash');
      expect(await request(socket, 'other', 'r2')).toEqual({
        type: 'auditLog',
        projectId: 'other',
        requestId: 'r2',
        status: 'unknown_project',
        entries: [],
        totalValid: 0,
        truncated: false,
        corruptLines: [],
        excludedCount: 0,
      });
      expectUnchanged();
    },
  );

  it('denies untokened connections without counts or writes', async () => {
    const socket = await connect(false);
    expect(await request(socket)).toEqual({
      type: 'auditLog',
      projectId: 'test',
      requestId: 'r1',
      status: 'denied',
      entries: [],
      totalValid: 0,
      truncated: false,
      corruptLines: [],
      excludedCount: 0,
    });
    expectUnchanged();
  });

  it('returns a sanitized read_error if the reader rejects', async () => {
    const socket = await connect(false, true);
    vi.spyOn(auditView, 'readAuditView').mockRejectedValue(new Error('private read failure'));
    expect(await request(socket)).toEqual({
      type: 'auditLog',
      projectId: 'test',
      requestId: 'r1',
      status: 'read_error',
      entries: [],
      totalValid: 0,
      truncated: false,
      corruptLines: [],
      excludedCount: 0,
    });
    expectUnchanged();
  });
});
