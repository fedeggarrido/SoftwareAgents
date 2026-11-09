import { OFFICE_TOKEN_QUERY } from '../../../core/src/constants.js';

interface PageHistory {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url: string): void;
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
