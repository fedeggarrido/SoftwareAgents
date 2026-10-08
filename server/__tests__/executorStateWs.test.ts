import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

// Isolated HOME: the server writes discovery records and reads Operator config there.
let tmpBase: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { PixelAgentsServer } = await import('../src/server.js');
const { AgentStateStore } = await import('../src/agentStateStore.js');
const { configureCompanyControl } = await import('../src/companyControl.js');
const { readConfig, writeConfig } = await import('../src/configPersistence.js');

let server: InstanceType<typeof PixelAgentsServer>;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-executor-ws-'));
  fs.mkdirSync(path.join(tmpBase, '.pixel-agents'), { recursive: true });
  const workspace = path.join(tmpBase, 'workspace');
  fs.mkdirSync(path.join(workspace, '.softwareagents'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, '.softwareagents/project.yaml'),
    'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: test\nname: Test\nrepo:\n  remote: https://example.invalid/test.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n',
  );
  const config = readConfig();
  config.projects.test = { autonomyLevel: 'A1', allowedExecutors: ['codex'] };
  writeConfig(config);
  configureCompanyControl(workspace);
  server = new PixelAgentsServer();
});

afterEach(() => {
  server?.stop();
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

// Regression (found in the real office): the WS layer built a new send closure per
// message, so the per-connection executorState sequence restarted at 0 every time.
it('orders executorState snapshots per real WebSocket connection', async () => {
  const { port } = await server.start({ embedded: false, store: new AgentStateStore() });
  const socket = new WebSocket(`ws://127.0.0.1:${port.toString()}/ws`);
  const sequences: number[] = [];
  socket.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString()) as { type?: string; sequence?: number };
    if (msg.type === 'executorState') sequences.push(msg.sequence!);
  });
  await new Promise((resolve) => socket.on('open', resolve));
  socket.send(JSON.stringify({ type: 'webviewReady', capabilities: ['executorControls'] }));
  socket.send(JSON.stringify({ type: 'requestExecutorState', projectId: 'test' }));
  socket.send(JSON.stringify({ type: 'requestExecutorState', projectId: 'test' }));
  await vi.waitFor(() => expect(sequences).toHaveLength(3), { timeout: 5_000 });
  expect(sequences).toEqual([0, 1, 2]);
  socket.terminate();
});
