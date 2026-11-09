import { afterEach, describe, expect, it, vi } from 'vitest';

import { OFFICE_CLOSE_FORBIDDEN_ORIGIN, OFFICE_CLOSE_UNAUTHORIZED } from '../src/constants.js';
import { connectionCopy, getConnectionStatus } from '../src/office/connectionStatus.js';
import { WebSocketTransport } from '../src/transport/webSocketTransport.js';

class Socket {
  static latest: Socket;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    Socket.latest = this;
  }
  send() {}
  close() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('office connection copy', () => {
  it('names the local process and gives restart instructions and the next automatic attempt', () => {
    const copy = connectionCopy(
      'reconnecting',
      { cause: 'unavailable', attempt: 3, retryAt: 15_000 },
      10_000,
    );
    expect(copy.label).toContain('Reintentando');
    expect(copy.label).toContain('Próximo intento 3 en 5 s');
    expect(copy.explanation).toContain('pixel-agents que se ejecuta en tu ordenador');
    expect(copy.explanation).toContain('terminal donde lo lanzaste');
    expect(copy.explanation).toContain('npx pixel-agents');
    expect(copy.explanation).not.toContain('token');
  });
  it.each([
    ['unauthorized', 'La URL de acceso no es válida'],
    ['origin', 'ha rechazado el origen'],
  ] as const)('explains %s without inventing a retry or printing a token', (cause, text) => {
    const copy = connectionCopy('disconnected', { cause, attempt: 0, retryAt: null });
    expect(copy.explanation).toContain(text);
    expect(copy.explanation).toContain('terminal');
    expect(copy.label).not.toContain('Reintentando');
  });
  it('uses a neutral handshake message while connecting', () => {
    expect(connectionCopy('connecting').explanation).toContain(
      'Esperando a que confirme el modo de acceso',
    );
  });
  it.each([OFFICE_CLOSE_UNAUTHORIZED, OFFICE_CLOSE_FORBIDDEN_ORIGIN, 1006])(
    'maps close %i to its real cause, and allows a manual reconnect',
    (code) => {
      vi.useFakeTimers();
      vi.stubGlobal('WebSocket', Socket);
      const transport = new WebSocketTransport('ws://office/ws?token=NEVER_SHOW_THIS');
      transport.connect();
      Socket.latest.onclose?.({ code });
      expect(getConnectionStatus().cause).toBe(
        code === OFFICE_CLOSE_UNAUTHORIZED
          ? 'unauthorized'
          : code === OFFICE_CLOSE_FORBIDDEN_ORIGIN
            ? 'origin'
            : 'unavailable',
      );
      expect(transport.state).toBe(code === 1006 ? 'reconnecting' : 'disconnected');
      expect(JSON.stringify(connectionCopy(transport.state))).not.toContain('NEVER_SHOW_THIS');
      if (code === 1006) expect(getConnectionStatus().retryAt).not.toBeNull();
      const previous = Socket.latest;
      transport.reconnect();
      expect(Socket.latest).not.toBe(previous);
      transport.dispose();
    },
  );
});
