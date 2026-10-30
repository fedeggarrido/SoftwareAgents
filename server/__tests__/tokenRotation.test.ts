import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Writable } from 'stream';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { AgentStateStore } from '../src/agentStateStore.js';
import { createHttpServer, redactRequestUrl } from '../src/httpServer.js';
import { PixelAgentsServer } from '../src/server.js';
import { runTokenCommand } from '../src/tokenCommand.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => process.env.HOME! };
});

const originalHome = process.env.HOME;
let tmpHome: string | undefined;
afterEach(() => {
  process.env.HOME = originalHome;
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = undefined;
});

function isolatedHome() {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'token-rotation-'));
  process.env.HOME = tmpHome;
  return tmpHome;
}

it('redacts repeated and encoded token keys while preserving other query bytes', () => {
  expect(redactRequestUrl('/ws?x=a%20b&token=one&%74oken=two&TOKEN=three&y=4')).toBe(
    '/ws?x=a%20b&token=REDACTED&%74oken=REDACTED&TOKEN=REDACTED&y=4',
  );
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

it('old standalone query loses privilege after rotation while the new query authenticates', async () => {
  isolatedHome();
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
