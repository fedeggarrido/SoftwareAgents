import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  captureStandaloneSocketUrl,
  exchangeStandaloneSocketUrl,
} from '../src/transport/standaloneUrl.js';
import { WebSocketTransport } from '../src/transport/webSocketTransport.js';

// Public test fixture, never an operator credential.
const FIXTURE_TOKEN = 'sa116-fixture-capability';
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send() {}
  close() {
    this.onclose?.();
  }
}
let transport: WebSocketTransport | undefined;
afterEach(() => {
  transport?.dispose();
  transport = undefined;
  FakeSocket.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('SA-116 standalone token lifetime', () => {
  it('strips bootstrap codes before exchanging once and retains only the capability for reconnect', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    const history = { state: { kept: true }, replaceState: vi.fn() };
    const exchange = vi.fn(async () => {
      expect(history.replaceState).toHaveBeenCalledWith(history.state, '', '/?keep=yes#fragment');
      return { ok: true, json: async () => ({ token: FIXTURE_TOKEN }) } as Response;
    });
    const url = await exchangeStandaloneSocketUrl(
      'http://localhost:3100/?open=once&%6fpen=duplicate&keep=yes#fragment',
      history,
      exchange,
    );
    transport = new WebSocketTransport(url);
    transport.connect();
    expect(FakeSocket.instances[0].url).toBe(`ws://localhost:3100/ws?token=${FIXTURE_TOKEN}`);
    FakeSocket.instances[0].onopen!();
    FakeSocket.instances[0].onclose!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(exchange).toHaveBeenCalledOnce();
    expect(FakeSocket.instances[1].url).toBe(url);
    expect(url).not.toContain('once');
  });

  it.each(['expired', 'unavailable'])('leaves %s bootstrap access read-only', async (failure) => {
    const history = { state: null, replaceState: vi.fn() };
    const exchange = vi.fn(async () => {
      if (failure === 'unavailable') throw new Error('network');
      return { ok: false } as Response;
    });
    const url = await exchangeStandaloneSocketUrl(
      'http://localhost:3100/?open=once&token=untrusted',
      history,
      exchange,
    );
    expect(url).toBe('ws://localhost:3100/ws');
    expect(exchange).toHaveBeenCalledOnce();
    expect(history.replaceState).toHaveBeenLastCalledWith(null, '', '/');
  });

  it('copies the in-memory token only on explicit request from a connected transport', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    transport = new WebSocketTransport(`ws://localhost/ws?token=${FIXTURE_TOKEN}`);
    const write = vi.fn().mockResolvedValue(undefined);
    await expect(transport.copyOperatorToken(write)).rejects.toThrow();
    transport.connect();
    FakeSocket.instances[0].onopen!();
    await transport.copyOperatorToken(write);
    expect(write).toHaveBeenCalledExactlyOnceWith(FIXTURE_TOKEN);
  });
  it('captures and strips the token through the normal standalone transport entry point', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    const page = {
      location: { href: `http://office:3100/?token=${FIXTURE_TOKEN}` },
      history: {
        state: null,
        replaceState: vi.fn((_state: unknown, _unused: string, url: string) => {
          expect(FakeSocket.instances).toHaveLength(0);
          page.location.href = new URL(url, page.location.href).href;
        }),
      },
      addEventListener: vi.fn(),
    };
    vi.stubGlobal('window', page);
    const entryPath = '../src/transport/index.js';
    const entry = await import(entryPath);
    transport = entry.transport;
    expect(page.location.href).toBe('http://office:3100/');
    expect(FakeSocket.instances[0].url).toBe(`ws://office:3100/ws?token=${FIXTURE_TOKEN}`);
    FakeSocket.instances[0].readyState = 1;
    FakeSocket.instances[0].onopen?.();
    expect(transport!.state).toBe('connected');
    FakeSocket.instances[0].close();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances[1].url).toBe(`ws://office:3100/ws?token=${FIXTURE_TOKEN}`);
  });

  it('strips all token queries before connecting and retains privilege on reconnect but not reload', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    let href = `http://office:3100/?view=features&token=${FIXTURE_TOKEN}&%74oken=duplicate#office`;
    const history = {
      state: { view: 'features' },
      replaceState: vi.fn((_state: unknown, _unused: string, url: string) => {
        expect(FakeSocket.instances).toHaveLength(0);
        href = new URL(url, href).href;
      }),
    };
    const socketUrl = captureStandaloneSocketUrl(href, history);
    expect(href).toBe('http://office:3100/?view=features#office');
    expect(history.replaceState).toHaveBeenCalledWith(history.state, '', '/?view=features#office');
    transport = new WebSocketTransport(socketUrl);
    transport.connect();
    expect(FakeSocket.instances[0].url).toBe(`ws://office:3100/ws?token=${FIXTURE_TOKEN}`);
    FakeSocket.instances[0].readyState = 1;
    FakeSocket.instances[0].onopen?.();
    FakeSocket.instances[0].close();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances[1].url).toBe(socketUrl);
    expect(captureStandaloneSocketUrl(href, history)).toBe('ws://office:3100/ws');
    expect(history.replaceState).toHaveBeenCalledOnce();
  });

  it.each(['token=', '%74oken='])('removes an empty %s query too', (query) => {
    const history = { state: null, replaceState: vi.fn() };
    expect(captureStandaloneSocketUrl(`https://office/?${query}&view=ideas`, history)).toBe(
      'wss://office/ws',
    );
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/?view=ideas');
  });
});
