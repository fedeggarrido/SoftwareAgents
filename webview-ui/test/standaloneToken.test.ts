import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureStandaloneSocketUrl } from '../src/transport/standaloneUrl.js';
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
