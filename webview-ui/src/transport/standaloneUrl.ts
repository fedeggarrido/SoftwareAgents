import {
  OFFICE_EXCHANGE_PATH,
  OFFICE_OPEN_QUERY,
  OFFICE_TOKEN_QUERY,
} from '../../../core/src/constants.js';
import { OFFICE_BOOTSTRAP_REQUEST_TIMEOUT_MS } from '../constants.js';

interface PageHistory {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url: string): void;
}

/** Strip before any await; consume the code once, keeping the returned capability in memory. */
export async function exchangeStandaloneSocketUrl(
  href: string,
  history: PageHistory,
  exchange: typeof fetch = fetch,
): Promise<string> {
  const page = new URL(href);
  const code = page.searchParams.get(OFFICE_OPEN_QUERY);
  if (page.searchParams.has(OFFICE_OPEN_QUERY)) {
    page.searchParams.delete(OFFICE_OPEN_QUERY);
    history.replaceState(history.state, '', `${page.pathname}${page.search}${page.hash}`);
  }
  let socketUrl = captureStandaloneSocketUrl(page.href, history);
  if (code) {
    // A bootstrap navigation never falls back to a token supplied in the URL.
    const socket = new URL(socketUrl);
    socket.searchParams.delete(OFFICE_TOKEN_QUERY);
    socketUrl = socket.href;
    try {
      const response = await exchange(`${page.origin}${OFFICE_EXCHANGE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(OFFICE_BOOTSTRAP_REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const { token } = (await response.json()) as { token?: unknown };
        if (typeof token === 'string' && token) {
          socket.searchParams.set(OFFICE_TOKEN_QUERY, token);
          socketUrl = socket.href;
        }
      }
    } catch {
      // Invalid/expired codes and unavailable servers leave the normal read surface.
    }
  }
  return socketUrl;
}

/** Capture the handshake capability once and remove every token query from the page URL. */
export function captureStandaloneSocketUrl(href: string, history: PageHistory): string {
  const page = new URL(href);
  const token = page.searchParams.get(OFFICE_TOKEN_QUERY);
  if (page.searchParams.has(OFFICE_TOKEN_QUERY)) {
    page.searchParams.delete(OFFICE_TOKEN_QUERY);
    history.replaceState(history.state, '', `${page.pathname}${page.search}${page.hash}`);
  }
  const protocol = page.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${page.host}/ws${token ? `?${OFFICE_TOKEN_QUERY}=${encodeURIComponent(token)}` : ''}`;
}
