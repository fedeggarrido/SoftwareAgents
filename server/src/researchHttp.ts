import { lookup } from 'dns/promises';
import * as http from 'http';
import * as https from 'https';
import { isIP } from 'net';

import { RESEARCH_HTTP_BYTES, RESEARCH_HTTP_MS } from '../../core/src/research.js';

/** Fail closed on non-public/reserved space, including mapped IPv4. */
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 168].includes(b)) ||
      (a === 198 && [18, 19, 51].includes(b)) ||
      (a === 203 && b === 0)
    );
  }
  // Global unicast only; disallow transition mechanisms and documentation space.
  return isIP(address) === 6 && /^[23]/i.test(address) && !/^(2001:|2002:|3fff:)/i.test(address);
}
export type ResearchHttp = (
  url: string,
  init?: RequestInit,
) => Promise<{ text: string; headers: Headers }>;

/** Native fetch, pinned to a vetted DNS result via its dispatcher interface.
 * The minimal dispatcher uses Node's TLS/HTTP transport with an immutable lookup;
 * a second DNS resolution cannot rebind to a private host. Redirects fail closed.
 */
export const researchHttp: ResearchHttp = async (ref, init = {}) => {
  const url = new URL(ref);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('HTTP(S) URL without credentials required');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost'))
    throw new Error('Private research destination rejected');
  const signal = AbortSignal.any([
    AbortSignal.timeout(RESEARCH_HTTP_MS),
    ...(init.signal ? [init.signal] : []),
  ]);
  signal.throwIfAborted();
  const addresses = await Promise.race([
    lookup(host, { all: true }),
    new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Research HTTP timeout')), {
        once: true,
      });
    }),
  ]);
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new Error('Private or reserved research destination rejected');
  const pinned = addresses[0];
  interface Handler {
    onConnect(abort: () => void): void;
    onHeaders(status: number, headers: Buffer[], resume: () => void, statusText: string): void;
    onData(data: Buffer): void;
    onComplete(trailers: Buffer[]): void;
    onError(error: Error): void;
  }
  const dispatcher = {
    dispatch(
      options: {
        method: string;
        path: string;
        headers: string[];
        body?: AsyncIterable<Uint8Array>;
      },
      handler: Handler,
    ) {
      const request = (url.protocol === 'https:' ? https : http).request(
        url,
        {
          method: options.method,
          headers: options.headers,
          // Disable Node's dual-stack auto selection so lookup receives the scalar contract.
          autoSelectFamily: false,
          lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
        } as http.RequestOptions & { autoSelectFamily: boolean },
        (response) => {
          handler.onHeaders(
            response.statusCode!,
            response.rawHeaders.map((v) => Buffer.from(v)),
            () => response.resume(),
            response.statusMessage ?? '',
          );
          response.on('data', (chunk: Buffer) => handler.onData(chunk));
          response.on('end', () => handler.onComplete([]));
          response.on('error', (error) => handler.onError(error));
          response.on('aborted', () => handler.onError(new Error('Research response aborted')));
        },
      );
      request.on('error', (error) => handler.onError(error));
      handler.onConnect(() => request.destroy());
      void (async () => {
        if (options.body) for await (const chunk of options.body) request.write(chunk);
        request.end();
      })().catch((error: Error) => request.destroy(error));
      return true;
    },
  };
  const response = await fetch(url, {
    ...init,
    signal,
    redirect: 'error',
    dispatcher,
  } as RequestInit);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Research HTTP status ${response.status}`);
  }
  if (Number(response.headers.get('content-length')) > RESEARCH_HTTP_BYTES) {
    await response.body?.cancel();
    throw new Error('Research HTTP size limit');
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > RESEARCH_HTTP_BYTES) throw new Error('Research HTTP size limit');
        chunks.push(value);
      }
  } finally {
    await reader?.cancel();
  }
  return { text: Buffer.concat(chunks).toString('utf8'), headers: response.headers };
};
