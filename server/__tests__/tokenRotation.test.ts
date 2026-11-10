import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Writable } from 'stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { AgentStateStore } from '../src/agentStateStore.js';
import { OFFICE_CREDENTIAL_FILE, OFFICE_TOKEN_POLL_MS } from '../src/constants.js';
import { createHttpServer, redactRequestUrl } from '../src/httpServer.js';
import {
  loadOfficeCredential,
  readOfficeCredential,
  rotateOfficeToken,
} from '../src/officeToken.js';
import { PixelAgentsServer } from '../src/server.js';
import { runTokenCommand } from '../src/tokenCommand.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => process.env.HOME! };
});

const originalHome = process.env.HOME;
let tmpHome: string | undefined;
beforeEach(() => {
  for (const key of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(key, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  process.env.HOME = originalHome;
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = undefined;
});

function isolatedHome() {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'token-rotation-'));
  process.env.HOME = tmpHome;
  return tmpHome;
}

it('creates a user-only credential file where OS permissions can be inspected', (context) => {
  const home = isolatedHome();
  loadOfficeCredential();
  const credential = path.join(home, '.pixel-agents', OFFICE_CREDENTIAL_FILE);
  if (process.platform !== 'win32') {
    expect(fs.statSync(credential).mode & 0o777).toBe(0o600);
    return;
  }
  const acl = path.join(home, 'office-acl.txt');
  let sid: string | undefined;
  try {
    sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true })
      .toString()
      .match(/S-1-\d+(?:-\d+)+/)?.[0];
    execFileSync('icacls.exe', [credential, '/save', acl], { windowsHide: true });
  } catch {
    context.skip(true, 'Windows ACL tools unavailable in this host');
    return;
  }
  expect(sid).toBeDefined();
  const descriptor = fs.readFileSync(acl, 'utf16le');
  expect(descriptor).toContain(`(A;;FA;;;${sid})`);
  expect(descriptor.match(/\([^)]*\)/g)).toHaveLength(1);
});

it('keeps the standalone capability and default port through restart and persists CLI revocation', async (context) => {
  const home = isolatedHome();
  if (!loadOfficeCredential().persistent) {
    context.skip(
      true,
      'Persistent office access needs verified private ACLs, unavailable on this host',
    );
    return;
  }
  const first = new PixelAgentsServer();
  const config = await first.start({ embedded: false, store: new AgentStateStore() });
  const { token, port } = config;
  first.stop();
  // stop closes the listener asynchronously.
  await vi.waitFor(async () => {
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
  });
  const restarted = new PixelAgentsServer();
  let socket: WebSocket | undefined;
  try {
    const next = await restarted.start({ embedded: false, store: new AgentStateStore() });
    expect(next.token).toBe(token);
    expect(next.port).toBe(port);
    const credentialPath = path.join(home, '.pixel-agents', OFFICE_CREDENTIAL_FILE);
    expect(JSON.parse(fs.readFileSync(credentialPath, 'utf8')).token).toBe(token);
    if (process.platform !== 'win32') expect(fs.statSync(credentialPath).mode & 0o777).toBe(0o600);
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    await new Promise<void>((resolve, reject) => {
      socket!.once('open', resolve);
      socket!.once('error', reject);
    });
    const access = new Promise<Record<string, unknown>>((resolve) => {
      socket!.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'officeAccess') resolve(message);
      });
    });
    socket.send(JSON.stringify({ type: 'webviewReady' }));
    expect(await access).toMatchObject({ privileged: true, reason: null });
    const closed = new Promise((resolve) => socket!.once('close', resolve));
    const log = vi.fn();
    await runTokenCommand(['--rotate'], log);
    const rotated = readOfficeCredential().token;
    expect(rotated).not.toBe(token);
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    expect(JSON.stringify(log.mock.calls)).not.toContain(rotated);
    expect(await closed).toBe(4001);
    expect(next.token).toBe(rotated);
  } finally {
    socket?.terminate();
    restarted.stop();
  }
  const final = new PixelAgentsServer();
  try {
    const last = await final.start({ embedded: false, port: 0, store: new AgentStateStore() });
    expect(last.token).toBe(readOfficeCredential().token);
    expect(last.token).not.toBe(token);
  } finally {
    final.stop();
  }
});

it('revokes every standalone instance from Settings and rejects managed and unprivileged rotation', async (context) => {
  isolatedHome();
  if (!loadOfficeCredential().persistent) {
    context.skip(
      true,
      'Persistent office access needs verified private ACLs, unavailable on this host',
    );
    return;
  }
  const server = new PixelAgentsServer();
  const config = await server.start({ embedded: false, port: 0, store: new AgentStateStore() });
  const original = config.token;
  const otherServer = await createHttpServer({
    embedded: false,
    port: 0,
    store: new AgentStateStore(),
    token: original,
    getToken: () => readOfficeCredential().token,
    onRotateToken: rotateOfficeToken,
  });
  const sockets: WebSocket[] = [];
  const startSocket = async (port: number, token: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return socket;
  };
  try {
    expect(config.port).not.toBe(otherServer.port);
    const denied = await startSocket(config.port, 'wrong');
    const notice = new Promise((resolve) => denied.once('message', resolve));
    denied.send(JSON.stringify({ type: 'rotateOfficeToken' }));
    await notice;
    expect(readOfficeCredential().token).toBe(original);
    const operator = await startSocket(config.port, original);
    vi.stubEnv('SA_MANAGED_EXECUTION', '');
    const managedNotice = new Promise((resolve) => operator.once('message', resolve));
    operator.send(JSON.stringify({ type: 'rotateOfficeToken' }));
    await managedNotice;
    await expect(runTokenCommand(['--rotate'], () => {})).rejects.toThrow('operador humano');
    expect(readOfficeCredential().token).toBe(original);
    vi.stubEnv('SA_MANAGED_EXECUTION', undefined);
    const other = await startSocket(otherServer.port, original);
    const revoked = [operator, other].map(
      (socket) => new Promise((resolve) => socket.once('close', resolve)),
    );
    operator.send(JSON.stringify({ type: 'rotateOfficeToken' }));
    expect(await Promise.all(revoked)).toEqual([4001, 4001]);
    await vi.waitFor(() => expect(config.token).toBe(readOfficeCredential().token), {
      timeout: OFFICE_TOKEN_POLL_MS * 3,
    });
  } finally {
    for (const socket of sockets) socket.terminate();
    server.stop();
    await otherServer.app.close();
  }
});

it('redacts repeated and encoded token keys while preserving other query bytes', () => {
  expect(redactRequestUrl('/ws?x=a%20b&token=one&%74oken=two&TOKEN=three&y=4')).toBe(
    '/ws?x=a%20b&token=REDACTED&%74oken=REDACTED&TOKEN=REDACTED&y=4',
  );
});

it('reports a rotation failure without exposing either the token or the underlying error', async () => {
  isolatedHome();
  const handle = await createHttpServer({
    embedded: false,
    token: 'private-capability',
    store: new AgentStateStore(),
    onRotateToken: () => {
      throw new Error('private-capability disk error');
    },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/ws?token=private-capability`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const reply = new Promise((resolve) =>
      socket.once('message', (data) => resolve(JSON.parse(data.toString()))),
    );
    socket.send(JSON.stringify({ type: 'rotateOfficeToken' }));
    expect(await reply).toEqual({ type: 'officeTokenRotationFailed' });
  } finally {
    socket.terminate();
    await handle.app.close();
  }
});

it('never logs query credentials for HTTP, missing routes or WS upgrades', async () => {
  isolatedHome();
  let logs = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logs += chunk.toString();
      callback();
    },
  });
  const { app, port } = await createHttpServer({
    embedded: false,
    token: 'server-secret',
    store: new AgentStateStore(),
    logStream: stream,
  });
  try {
    await app.inject({
      url: '/api/health?token=http-secret&keep=yes',
      headers: { authorization: 'Bearer header-secret' },
    });
    await app.inject({ url: '/missing?token=missing-secret' });
    app.log.info({ headers: { authorization: 'Bearer explicit-header-secret' } }, 'headers');
    app.log.error({ err: new Error('/ws?token=error-secret') }, 'failure');
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=ws-secret&keep=yes`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.close();
    await closed;
    expect(logs).toContain('token=REDACTED&keep=yes');
    for (const secret of [
      'http-secret',
      'header-secret',
      'ws-secret',
      'missing-secret',
      'explicit-header-secret',
      'error-secret',
    ])
      expect(logs).not.toContain(secret);
  } finally {
    await app.close();
  }
});

it('CLI rotates a live token, closes old sockets, republishes discovery and audits without secrets', async () => {
  const home = isolatedHome();
  const server = new PixelAgentsServer();
  const config = await server.start({ embedded: true, store: new AgentStateStore() });
  const old = config.token;
  const url = `http://127.0.0.1:${config.port}`;
  const socket = new WebSocket(`ws://127.0.0.1:${config.port}/ws`, {
    headers: { Authorization: `Bearer ${old}` },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const closed = new Promise((resolve) => socket.once('close', resolve));
    const forbidden = await fetch(`${url}/api/token/rotate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${old}`, Origin: url },
    });
    expect(forbidden.status).toBe(403);
    await runTokenCommand(['rotate', '--port', String(config.port)], () => {});
    await closed;
    expect(config.token).not.toBe(old);
    for (const file of ['server.json', `servers/${config.pid}-${config.port}.json`]) {
      const full = path.join(home, '.pixel-agents', file);
      expect(JSON.parse(fs.readFileSync(full, 'utf8')).token).toBe(config.token);
      if (process.platform !== 'win32') expect(fs.statSync(full).mode & 0o777).toBe(0o600);
    }
    const post = (token: string) =>
      fetch(`${url}/api/hooks/claude`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
    expect((await post(old)).status).toBe(401);
    expect((await post(config.token)).status).toBe(200);
    expect(
      (
        await fetch(`${url}/api/token/rotate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${old}` },
        })
      ).status,
    ).toBe(401);
    const rejected = new WebSocket(`ws://127.0.0.1:${config.port}/ws`, {
      headers: { Authorization: `Bearer ${old}` },
    });
    expect(await new Promise((resolve) => rejected.once('close', resolve))).toBe(4001);
    const audit = fs.readFileSync(path.join(home, '.pixel-agents/audit/machine.jsonl'), 'utf8');
    expect(audit).toContain('server.token.rotate');
    expect(audit).not.toContain(old);
    expect(audit).not.toContain(config.token);
  } finally {
    socket.terminate();
    server.stop();
  }
  const restarted = new PixelAgentsServer();
  try {
    expect(
      (await restarted.start({ embedded: true, store: new AgentStateStore() })).token,
    ).not.toBe(config.token);
  } finally {
    restarted.stop();
  }
});

it('old standalone query loses privilege after rotation while the new query authenticates', async (context) => {
  isolatedHome();
  if (!loadOfficeCredential().persistent) {
    context.skip(
      true,
      'Persistent office access needs verified private ACLs, unavailable on this host',
    );
    return;
  }
  const effects = vi.fn();
  const server = new PixelAgentsServer();
  const config = await server.start({
    embedded: false,
    store: new AgentStateStore(),
    onSetHooksEnabled: effects,
  });
  const old = config.token;
  const sockets: WebSocket[] = [];
  async function consentRequest(token: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${config.port}/ws?token=${token}`);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const status = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Missing hooksStatus')), 2000);
      socket.on('message', (data) => {
        if (JSON.parse(data.toString()).type === 'hooksStatus') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    socket.send(JSON.stringify({ type: 'setHooksEnabled', providerId: 'claude', enabled: false }));
    await status;
  }
  try {
    await runTokenCommand(['rotate'], () => {});
    await consentRequest(old);
    expect(effects).not.toHaveBeenCalled();
    await consentRequest(config.token);
    expect(effects).toHaveBeenCalledWith('claude', false);
  } finally {
    for (const socket of sockets) socket.terminate();
    server.stop();
  }
});
