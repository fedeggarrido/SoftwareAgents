import { createHash, timingSafeEqual } from 'crypto';
import { Writable } from 'stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { OFFICE_EXCHANGE_PATH, OFFICE_OPEN_PATH } from '../../core/src/constants.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { OFFICE_BOOTSTRAP_RATE_LIMIT, OFFICE_BOOTSTRAP_TTL_MS } from '../src/constants.js';
import { createHttpServer } from '../src/httpServer.js';

vi.mock('crypto', async (original) => {
  const crypto = await original<typeof import('crypto')>();
  return { ...crypto, timingSafeEqual: vi.fn(crypto.timingSafeEqual) };
});

let app: Awaited<ReturnType<typeof createHttpServer>>['app'];
const token = 'persistent-token-test-fixture';
let logs = '';
beforeEach(async () => {
  for (const key of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(key, undefined);
  logs = '';
  ({ app } = await createHttpServer({
    embedded: false,
    token,
    store: new AgentStateStore(),
    logStream: new Writable({
      write(chunk, _encoding, done) {
        logs += chunk.toString();
        done();
      },
    }),
  }));
});
afterEach(async () => {
  await app?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function code() {
  const response = await app.inject({
    method: 'POST',
    url: OFFICE_OPEN_PATH,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(200);
  return response.json().code as string;
}
const exchange = (value: string) =>
  app.inject({ method: 'POST', url: OFFICE_EXCHANGE_PATH, payload: { code: value } });

it('exchanges once and rejects replay without logging either secret', async () => {
  const value = await code();
  expect(value).toMatch(/^[a-f0-9]{64}$/);
  const response = await exchange(value);
  expect(response.json()).toEqual({ token });
  expect(response.headers['cache-control']).toBe('no-store');
  expect((await exchange(value)).statusCode).toBe(403);
  await app.inject({
    method: 'POST',
    url: OFFICE_EXCHANGE_PATH,
    headers: { 'content-type': 'application/json' },
    payload: `{"code":"${value}",invalid}`,
  });
  await app.inject({ url: `/?open=${value}&%6fpen=${value}&code=${value}&token=${token}` });
  expect(logs).not.toContain(value);
  expect(logs).not.toContain(token);
});

it('rejects codes at expiry', async () => {
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const value = await code();
  vi.spyOn(Date, 'now').mockReturnValue(now + OFFICE_BOOTSTRAP_TTL_MS);
  expect((await exchange(value)).statusCode).toBe(403);
});

it('invalidates outstanding codes on rotation and permits independent browser opens', async () => {
  await app.close();
  let tokenNow = token;
  ({ app } = await createHttpServer({
    embedded: false,
    token,
    getToken: () => tokenNow,
    store: new AgentStateStore(),
  }));
  const first = await code();
  const second = await code();
  expect((await exchange(first)).statusCode).toBe(200);
  tokenNow = 'rotated-test-fixture';
  expect((await exchange(second)).statusCode).toBe(403);
});

it('rejects invalid codes and preserves the unused valid code', async () => {
  const value = await code();
  expect((await exchange('wrong')).statusCode).toBe(403);
  expect((await exchange(value)).statusCode).toBe(200);
});

it('compares fixed-size SHA-256 digests for every pending entry on hits and misses', async () => {
  const first = await code();
  const second = await code();
  const compare = vi.mocked(timingSafeEqual);
  const digest = (value: string) => createHash('sha256').update(value).digest();
  for (const value of ['wrong', '', 'a'.repeat(128), first]) {
    compare.mockClear();
    const response = await exchange(value);
    expect(response.statusCode).toBe(value === first ? 200 : 403);
    expect(compare).toHaveBeenCalledWith(digest(value), digest(first));
    expect(compare).toHaveBeenCalledWith(digest(value), digest(second));
    expect(compare).toHaveBeenCalledTimes(3);
    for (const [supplied, stored] of compare.mock.calls) {
      expect(supplied.byteLength).toBe(32);
      expect(stored.byteLength).toBe(32);
    }
  }
  expect((await exchange(first)).json()).toEqual({ error: 'unavailable' });
  expect((await exchange(second)).json()).toEqual({ token });
  compare.mockClear();
  expect((await exchange('missing')).json()).toEqual({ error: 'unavailable' });
  expect(compare).toHaveBeenCalledOnce();
});

it.each([
  { remoteAddress: '192.168.1.4' },
  { headers: { host: 'evil.example' } },
  { headers: { origin: 'http://evil.example' } },
])('rejects non-loopback peers, DNS rebinding and foreign origins: %j', async (options) => {
  const value = await code();
  const response = await app.inject({
    method: 'POST',
    url: OFFICE_EXCHANGE_PATH,
    payload: { code: value },
    ...options,
  });
  expect(response.statusCode).toBe(403);
  expect((await exchange(value)).statusCode).toBe(200);
});

it('limits failed attempts and requires the human capability to mint codes', async () => {
  expect((await app.inject({ method: 'POST', url: OFFICE_OPEN_PATH })).statusCode).toBe(403);
  for (let index = 1; index < OFFICE_BOOTSTRAP_RATE_LIMIT; index++) await exchange('wrong');
  expect((await exchange('wrong')).statusCode).toBe(429);
});

it('rejects browser minting and managed processes', async () => {
  expect(
    (
      await app.inject({
        method: 'POST',
        url: OFFICE_OPEN_PATH,
        headers: { authorization: `Bearer ${token}`, origin: 'http://localhost:80' },
      })
    ).statusCode,
  ).toBe(403);
  vi.stubEnv('SA_MANAGED_EXECUTION', '1');
  expect(
    (
      await app.inject({
        method: 'POST',
        url: OFFICE_OPEN_PATH,
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode,
  ).toBe(403);
});
