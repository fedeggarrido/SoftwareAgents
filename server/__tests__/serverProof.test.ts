import { createHmac } from 'crypto';
import * as http from 'http';
import { afterEach, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import {
  OPERATOR_PROOF_CONTEXT,
  OPERATOR_PROOF_MAX_BODY_CHARS,
  OPERATOR_PROOF_NONCE_BYTES,
  OPERATOR_PROOF_PATH,
} from '../src/constants.js';
import { createHttpServer, type HttpServerHandle } from '../src/httpServer.js';
import { verifyServerProof } from '../src/serverProof.js';

let app: HttpServerHandle | undefined;
let listener: http.Server | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await app?.app.close();
  app = undefined;
  if (listener) {
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      listener!.close((error) => (error ? reject(error) : resolve())),
    );
    listener = undefined;
  }
});

it('proves the current token and PID with fresh nonces and invalidates rotation', async () => {
  // Rotation is a human-only route; a test run launched from an agent session must not inherit that marker.
  for (const key of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(key, undefined);
  app = await createHttpServer({
    embedded: true,
    token: 'secret',
    store: new AgentStateStore(),
    onRotateToken: () => 'rotated',
  });
  const target = { port: app.port, pid: process.pid, token: 'secret', host: '192.0.2.1' };
  await expect(verifyServerProof(target)).resolves.toBe(true);
  await expect(verifyServerProof({ ...target, pid: process.pid + 1 })).resolves.toBe(false);
  const nonce = 'ab'.repeat(OPERATOR_PROOF_NONCE_BYTES);
  const response = await app.app.inject({ url: `${OPERATOR_PROOF_PATH}?nonce=${nonce}` });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toEqual({
    proof: createHmac('sha256', 'secret')
      .update(`${OPERATOR_PROOF_CONTEXT}${nonce}:${process.pid}`)
      .digest('hex'),
  });
  expect((await app.app.inject({ url: OPERATOR_PROOF_PATH })).statusCode).toBe(400);
  expect(
    (
      await app.app.inject({
        url: `${OPERATOR_PROOF_PATH}?nonce=${nonce}`,
        headers: { origin: 'http://evil.example' },
      })
    ).statusCode,
  ).toBe(403);
  await app.app.inject({
    method: 'POST',
    url: '/api/token/rotate',
    headers: { authorization: 'Bearer secret' },
  });
  await expect(verifyServerProof(target)).resolves.toBe(false);
  await expect(verifyServerProof({ ...target, token: 'rotated' })).resolves.toBe(true);
});

it.each(['wrong proof', 'malformed', 'oversized', 'redirect', 'reset', 'stall', 'stream'])(
  'fails closed on %s without transmitting the token',
  async (scenario) => {
    const requests: { url?: string; headers: http.IncomingHttpHeaders }[] = [];
    listener = http.createServer((request, response) => {
      requests.push({ url: request.url, headers: request.headers });
      if (scenario === 'reset') return request.destroy();
      if (scenario === 'stall') return;
      if (scenario === 'stream') {
        const timer = setInterval(() => response.write(' '), 5);
        response.on('close', () => clearInterval(timer));
        return;
      }
      if (scenario === 'redirect') response.writeHead(302, { Location: '/elsewhere' });
      response.end(
        scenario === 'malformed'
          ? '{'
          : scenario === 'oversized'
            ? 'x'.repeat(OPERATOR_PROOF_MAX_BODY_CHARS + 1)
            : JSON.stringify({ proof: '00'.repeat(32) }),
      );
    });
    await new Promise<void>((resolve) => listener!.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as import('net').AddressInfo).port;
    const target = { port, pid: process.pid, token: 'never-transmit-this' };
    await expect(verifyServerProof(target, 100)).resolves.toBe(false);
    await expect(verifyServerProof(target, 100)).resolves.toBe(false);
    expect(requests).toHaveLength(2);
    expect(requests[0].url).not.toBe(requests[1].url);
    expect(JSON.stringify(requests)).not.toContain(target.token);
    expect(requests.every((request) => request.headers.authorization === undefined)).toBe(true);
  },
);
