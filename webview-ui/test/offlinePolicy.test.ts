import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientMessage } from '../../core/src/messages.js';
import {
  getConnectionStatus,
  setConnectionStatus,
  setUnsent,
  staleDataText,
} from '../src/office/connectionStatus.js';
import { WebSocketTransport } from '../src/transport/webSocketTransport.js';

class FakeSocket {
  static latest: FakeSocket;
  readyState = 0;
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSocket.latest = this;
  }
  send(data: string) {
    // SAFETY: the transport only ever sends serialized ClientMessages.
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  close() {}
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const decision: ClientMessage = { type: 'companyDecision', id: 'd', answer: 'a' };

describe('offline sends', () => {
  let transport: WebSocketTransport;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    setConnectionStatus({ cause: 'unavailable', attempt: 0, retryAt: null });
    transport = new WebSocketTransport('ws://office/ws');
    transport.connect();
    FakeSocket.latest.open();
  });
  afterEach(() => {
    transport.dispose();
    setConnectionStatus({ cause: 'unavailable', attempt: 0, retryAt: null });
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const reconnect = () => {
    vi.advanceTimersByTime(1000);
    FakeSocket.latest.open();
    return FakeSocket.latest.sent;
  };

  it('drops an action with a notice that survives the reconnection and never replays it', () => {
    FakeSocket.latest.drop();
    transport.send(decision);
    expect(getConnectionStatus().unsent).toBe('action');
    expect(reconnect()).toEqual([]);
    expect(getConnectionStatus().unsent).toBe('action');
    setUnsent(null);
    expect(getConnectionStatus().unsent).toBeNull();
  });
  it('keeps only the latest save, writes it before the new handshake and clears its notice', () => {
    FakeSocket.latest.drop();
    transport.send({ type: 'setSoundEnabled', enabled: true });
    expect(getConnectionStatus().unsent).toBeFalsy();
    transport.send({ type: 'setSoundEnabled', enabled: false });
    transport.send({ type: 'saveLayout', layout: { version: 1 } });
    expect(getConnectionStatus().unsent).toBe('save');
    transport.onStateChange((state) => {
      if (state === 'connected') transport.send({ type: 'webviewReady' });
    });
    expect(reconnect().map(({ type }) => type)).toEqual([
      'setSoundEnabled',
      'saveLayout',
      'webviewReady',
    ]);
    expect(FakeSocket.latest.sent[0]).toEqual({ type: 'setSoundEnabled', enabled: false });
    expect(getConnectionStatus().unsent).toBeNull();
  });
  it('does not let a pending save hide an action that was never sent', () => {
    FakeSocket.latest.drop();
    transport.send(decision);
    transport.send({ type: 'saveLayout', layout: { version: 1 } });
    expect(getConnectionStatus().unsent).toBe('action');
  });
  it('dates the data from the last message received, never from the attempt', () => {
    expect(staleDataText(getConnectionStatus().lastContactAt)).toBeNull();
    vi.setSystemTime(new Date(2026, 10, 25, 22, 31, 5));
    FakeSocket.latest.onmessage?.({ data: '{"type":"companyNotice","text":""}' });
    vi.setSystemTime(new Date(2026, 10, 25, 22, 40, 0));
    FakeSocket.latest.drop();
    expect(staleDataText(getConnectionStatus().lastContactAt)).toContain('22:31:05');
  });
});
