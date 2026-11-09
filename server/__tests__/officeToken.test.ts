import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { AgentStateStore } from '../src/agentStateStore.js';
import { OFFICE_CREDENTIAL_FILE } from '../src/constants.js';
import { loadOfficeCredential, rememberOfficePort } from '../src/officeToken.js';
import { PixelAgentsServer } from '../src/server.js';

const mocks = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  execFileSync: mocks.exec,
}));
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let home: string;
let server: PixelAgentsServer | undefined;
const sockets: WebSocket[] = [];
const sid = 'S-1-5-21-123-456-789-1001';

beforeEach(() => {
  for (const key of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(key, undefined);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-acl-'));
  vi.stubEnv('HOME', home);
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  mocks.exec.mockReset().mockImplementation((command: string) => {
    if (command.endsWith('whoami.exe')) return Buffer.from(`"user","${sid}"`);
    if (command.endsWith('powershell.exe')) return Buffer.from('verified');
    return Buffer.from('');
  });
});
afterEach(() => {
  for (const socket of sockets) socket.terminate();
  sockets.length = 0;
  server?.stop();
  server = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.defineProperty(process, 'platform', platform);
  const target = path.resolve(home);
  if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep))
    throw new Error('Invalid test home');
  fs.rmSync(target, { recursive: true, force: true });
});

async function access(port: number, token: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  sockets.push(socket);
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    socket.once('error', reject);
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'officeAccess') resolve(message);
    });
    socket.once('open', () => socket.send(JSON.stringify({ type: 'webviewReady' })));
  });
}

it('persists capability and port through restart when ACL application and verification succeed', async () => {
  server = new PixelAgentsServer();
  const first = await server.start({ embedded: false, store: new AgentStateStore() });
  const { token, port } = first;
  expect(await access(port, token)).toMatchObject({ privileged: true, persistent: true });
  for (const socket of sockets) socket.terminate();
  server.stop();
  await vi.waitFor(async () => {
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
  });
  server = new PixelAgentsServer();
  const restarted = await server.start({ embedded: false, store: new AgentStateStore() });
  expect(restarted.token).toBe(token);
  expect(restarted.port).toBe(port);
  expect(await access(port, token)).toMatchObject({ privileged: true, persistent: true });
  const rotated = await fetch(`http://127.0.0.1:${port}/api/token/rotate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(rotated.status).toBe(200);
  expect(await access(port, token)).toMatchObject({ privileged: false });
  expect(loadOfficeCredential().token).not.toBe(token);
});

it('verifies the ACL on an empty temporary before writing and publishing the secret', () => {
  mocks.exec.mockImplementation((command: string, args: string[]) => {
    if (command.endsWith('whoami.exe')) return Buffer.from(sid);
    if (command.endsWith('icacls.exe')) expect(fs.readFileSync(args[0], 'utf8')).toBe('');
    return Buffer.from(command.endsWith('powershell.exe') ? 'verified' : '');
  });
  const credential = loadOfficeCredential();
  expect(credential.persistent).toBe(true);
  expect(
    JSON.parse(fs.readFileSync(path.join(home, '.pixel-agents', OFFICE_CREDENTIAL_FILE), 'utf8'))
      .token,
  ).toBe(credential.token);
  expect(mocks.exec.mock.calls.some(([command]) => command.endsWith('powershell.exe'))).toBe(true);
});

it.each(['EPERM', 'ENOENT', 'EACCES'])(
  'falls back without writing a secret if whoami fails with %s',
  (code) => {
    mocks.exec.mockImplementation(() => {
      throw Object.assign(new Error('Unavailable'), { code });
    });
    const first = loadOfficeCredential();
    expect(first.persistent).toBe(false);
    expect(loadOfficeCredential().token).not.toBe(first.token);
    expect(fs.existsSync(path.join(home, '.pixel-agents', OFFICE_CREDENTIAL_FILE))).toBe(false);
    expect(
      fs.readdirSync(path.join(home, '.pixel-agents')).some((file) => file.endsWith('.tmp')),
    ).toBe(false);
  },
);

it.each(['icacls.exe', 'powershell.exe'])(
  'fails closed if %s fails, including an existing persistent token',
  (tool) => {
    const original = loadOfficeCredential();
    mocks.exec.mockImplementation((command: string) => {
      if (command.endsWith(tool)) throw new Error('ACL unavailable');
      return Buffer.from(command.endsWith('whoami.exe') ? sid : 'verified');
    });
    const fallback = loadOfficeCredential();
    expect(fallback.persistent).toBe(false);
    expect(fallback.token).not.toBe(original.token);
    expect(() => rememberOfficePort(3100)).toThrow();
    expect(
      JSON.parse(fs.readFileSync(path.join(home, '.pixel-agents', OFFICE_CREDENTIAL_FILE), 'utf8'))
        .token,
    ).toBe(original.token);
  },
);

it('rejects unsuccessful verification even with exit code zero', () => {
  mocks.exec.mockImplementation((command: string) =>
    Buffer.from(command.endsWith('whoami.exe') ? sid : ''),
  );
  expect(loadOfficeCredential().persistent).toBe(false);
  expect(fs.existsSync(path.join(home, '.pixel-agents', OFFICE_CREDENTIAL_FILE))).toBe(false);
});

it('keeps a server usable with a per-run token when ACL tools are unavailable', async () => {
  for (const key of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(key, undefined);
  mocks.exec.mockImplementation(() => {
    throw Object.assign(new Error('Unavailable'), { code: 'EPERM' });
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  server = new PixelAgentsServer();
  const config = await server.start({ embedded: false, store: new AgentStateStore() });
  const url = new URL(await server.officeOpenUrl());
  expect(url.searchParams.has('token')).toBe(false);
  const response = await fetch(`${url.origin}/api/office/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: url.searchParams.get('open') }),
  });
  expect(((await response.json()) as { token: string }).token).toBe(config.token);
  expect(fs.existsSync(path.join(home, '.pixel-agents', OFFICE_CREDENTIAL_FILE))).toBe(false);
  expect(fs.existsSync(path.join(home, '.pixel-agents', 'server.json'))).toBe(false);
  expect(await access(config.port, config.token)).toMatchObject({
    privileged: true,
    persistent: false,
  });
});
