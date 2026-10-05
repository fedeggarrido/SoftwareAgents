import * as http from 'http';

import { SERVER_HEALTH_MAX_BODY_CHARS, SERVER_HEALTH_PROBE_TIMEOUT_MS } from './constants.js';
import type { ServerTarget } from './serverConfig.js';
import { isLocalContactHost } from './serverConfig.js';

export type ServerProbe = 'healthy' | 'stale' | 'unknown';

/**
 * Bounded liveness check, without sending the token. Health's PID is not server
 * authentication: a local impostor can imitate it and receive subsequent hook
 * tokens/events. Nonce/HMAC authentication is deferred (see CLAUDE.md discovery).
 */
export function probeServer(
  target: Pick<ServerTarget, 'port' | 'pid' | 'host'>,
  timeoutMs = SERVER_HEALTH_PROBE_TIMEOUT_MS,
): Promise<ServerProbe> {
  if (target.host !== undefined && !isLocalContactHost(target.host))
    return Promise.resolve('unknown');
  return new Promise((resolve) => {
    let settled = false;
    let req: http.ClientRequest | undefined;
    const finish = (verdict: ServerProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(verdict);
      req?.destroy();
    };
    // An absolute deadline also bounds a peer that continuously streams data.
    const deadline = setTimeout(() => finish('unknown'), timeoutMs);
    try {
      req = http.get(
        { hostname: target.host ?? '127.0.0.1', port: target.port, path: '/api/health' },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            if (body.length + chunk.length > SERVER_HEALTH_MAX_BODY_CHARS) {
              finish('stale');
              return;
            }
            body += chunk;
          });
          res.on('end', () => {
            try {
              const health: unknown = JSON.parse(body);
              finish(
                res.statusCode === 200 &&
                  health !== null &&
                  typeof health === 'object' &&
                  'pid' in health &&
                  health.pid === target.pid
                  ? 'healthy'
                  : 'stale',
              );
            } catch {
              finish('stale');
            }
          });
          res.on('error', () => finish('unknown'));
          res.on('aborted', () => finish('unknown'));
        },
      );
      req.on('error', (error: NodeJS.ErrnoException) =>
        finish(error.code === 'ECONNREFUSED' ? 'stale' : 'unknown'),
      );
    } catch {
      finish('unknown');
    }
  });
}
