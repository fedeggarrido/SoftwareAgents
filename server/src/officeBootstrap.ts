import { randomBytes } from 'crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isIP } from 'net';

import { OFFICE_EXCHANGE_PATH, OFFICE_OPEN_PATH } from '../../core/src/constants.js';
import {
  OFFICE_BOOTSTRAP_BYTES,
  OFFICE_BOOTSTRAP_RATE_LIMIT,
  OFFICE_BOOTSTRAP_RATE_WINDOW_MS,
  OFFICE_BOOTSTRAP_TTL_MS,
} from './constants.js';
import { featureIngressActor } from './featureIngress.js';

function localRequest(request: FastifyRequest): boolean {
  const loopback = (host: string) =>
    host === '::1' ||
    host === '[::1]' ||
    host === 'localhost' ||
    (isIP(host) === 4 && host.startsWith('127.'));
  if (!loopback(request.ip) && !loopback(request.ip.replace(/^::ffff:/, ''))) return false;
  try {
    const url = new URL(`${request.protocol}://${request.headers.host}`);
    return (
      loopback(url.hostname) &&
      (request.headers.origin === undefined || request.headers.origin === url.origin)
    );
  } catch {
    return false;
  }
}

/** Bounded process-local codes; no credential ever goes to the OS opener. */
export function registerOfficeBootstrap(
  app: FastifyInstance,
  currentToken: () => string,
  authenticate: (request: FastifyRequest) => boolean,
): void {
  const pending = new Map<string, { expires: number; token: string }>();
  let windowStart = Date.now();
  let attempts = 0;
  const guard = (request: FastifyRequest) => {
    if (!localRequest(request)) return 403;
    if (Date.now() - windowStart >= OFFICE_BOOTSTRAP_RATE_WINDOW_MS) {
      windowStart = Date.now();
      attempts = 0;
    }
    return ++attempts > OFFICE_BOOTSTRAP_RATE_LIMIT ? 429 : null;
  };
  app.post(OFFICE_OPEN_PATH, { logLevel: 'silent' }, (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const status = guard(request);
    if (status) return reply.code(status).send({ error: 'unavailable' });
    if (
      request.headers.origin !== undefined ||
      featureIngressActor() !== 'human' ||
      !authenticate(request)
    )
      return reply.code(403).send({ error: 'unavailable' });
    for (const [code, entry] of pending) if (Date.now() >= entry.expires) pending.delete(code);
    const code = randomBytes(OFFICE_BOOTSTRAP_BYTES).toString('hex');
    pending.set(code, {
      expires: Date.now() + OFFICE_BOOTSTRAP_TTL_MS,
      token: currentToken(),
    });
    return { code };
  });
  app.post<{ Body: { code?: unknown } }>(
    OFFICE_EXCHANGE_PATH,
    { logLevel: 'silent' },
    (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const status = guard(request);
      if (status) return reply.code(status).send({ error: 'unavailable' });
      const code = typeof request.body?.code === 'string' ? request.body.code : '';
      const entry = pending.get(code);
      if (entry && Date.now() >= entry.expires) pending.delete(code);
      if (!entry || Date.now() >= entry.expires || entry.token !== currentToken())
        return reply.code(403).send({ error: 'unavailable' });
      const token = entry.token;
      pending.delete(code);
      return { token };
    },
  );
}
