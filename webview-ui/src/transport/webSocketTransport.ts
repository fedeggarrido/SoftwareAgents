import {
  TRANSPORT_STATE_CONNECTED,
  TRANSPORT_STATE_CONNECTING,
  TRANSPORT_STATE_DISCONNECTED,
  TRANSPORT_STATE_RECONNECTING,
} from '../../../core/src/constants.js';
import type { ClientMessage, ServerMessage } from '../../../core/src/messages.js';
import {
  OFFICE_CLOSE_FORBIDDEN_ORIGIN,
  OFFICE_CLOSE_UNAUTHORIZED,
  OFFICE_RETRY_BASE_MS,
  OFFICE_RETRY_MAX_MS,
} from '../constants.js';
import { getConnectionStatus, setConnectionStatus } from '../office/connectionStatus.js';
import type { MessageTransport, TransportState } from './types.js';

// Structural socket contract keeps transport regressions runnable without DOM types.
interface TransportSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: { code: number }) => void) | null;
  onerror: (() => void) | null;
}
const SOCKET_OPEN = 1;
const LIVE_CONNECTION_COMMANDS: ReadonlySet<ClientMessage['type']> = new Set([
  'setExecutorEnabled',
  'setExecutorLevels',
  'submitIdea',
  'prepareProject',
  'rotateOfficeToken',
  'submitTaskChange',
]);

/**
 * WebSocket transport for standalone browser mode.
 * Connects to the Pixel Agents server via WebSocket for bidirectional messaging.
 * Includes automatic reconnection with exponential backoff and message queuing.
 */
export class WebSocketTransport implements MessageTransport {
  private ws: TransportSocket | null = null;
  private handlers: Array<(msg: ServerMessage) => void> = [];
  private stateHandlers: Array<(state: TransportState) => void> = [];
  private url: string | Promise<string>;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private resolvingUrl = false;
  private pendingMessages: ClientMessage[] = [];
  private _state: TransportState = TRANSPORT_STATE_CONNECTING;
  private readonly _ready: Promise<void>;
  private resolveReady!: () => void;

  constructor(url: string | Promise<string>) {
    this.url = url;
    this._ready = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
  }

  get state(): TransportState {
    return this._state;
  }

  get ready(): Promise<void> {
    return this._ready;
  }

  private setState(next: TransportState): void {
    setConnectionStatus({ ...getConnectionStatus(), state: next });
    if (this._state === next) return;
    this._state = next;
    for (const handler of this.stateHandlers) handler(next);
  }

  connect(): void {
    if (this.disposed) return;
    if (typeof this.url !== 'string') {
      if (this.resolvingUrl) return;
      this.resolvingUrl = true;
      void this.url.then((url) => {
        this.url = url;
        this.resolvingUrl = false;
        this.connect();
      });
      return;
    }

    // First attempt is "connecting"; any retry after a drop is "reconnecting".
    this.setState(
      this.reconnectAttempts > 0 ? TRANSPORT_STATE_RECONNECTING : TRANSPORT_STATE_CONNECTING,
    );

    const Socket = (globalThis as unknown as { WebSocket: new (url: string) => TransportSocket })
      .WebSocket;
    this.ws = new Socket(this.url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      setConnectionStatus({ cause: 'unavailable', attempt: 0, retryAt: null });
      console.log('[Transport] WebSocket connected');
      this.setState(TRANSPORT_STATE_CONNECTED);
      this.resolveReady();
      // Flush any messages queued while connecting
      for (const msg of this.pendingMessages) {
        this.ws!.send(JSON.stringify(msg));
      }
      this.pendingMessages = [];
    };

    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string) as ServerMessage;
        for (const handler of this.handlers) handler(msg);
      } catch {
        // Malformed JSON, ignore
      }
    };

    this.ws.onclose = (event) => {
      if (!this.disposed) {
        const cause =
          event?.code === OFFICE_CLOSE_UNAUTHORIZED
            ? 'unauthorized'
            : event?.code === OFFICE_CLOSE_FORBIDDEN_ORIGIN
              ? 'origin'
              : 'unavailable';
        if (cause !== 'unavailable') {
          setConnectionStatus({ cause, attempt: 0, retryAt: null });
          this.setState(TRANSPORT_STATE_DISCONNECTED);
          return;
        }
        this.scheduleReconnect();
        this.setState(TRANSPORT_STATE_RECONNECTING);
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror, triggering reconnect
    };
  }

  async copyOperatorToken(write: (text: string) => Promise<void>): Promise<void> {
    const token = new URL(await this.url).searchParams.get('token');
    if (!token || this._state !== TRANSPORT_STATE_CONNECTED) throw new Error('Access unavailable');
    await write(token);
  }

  reconnect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.close();
    }
    this.reconnectAttempts++;
    setConnectionStatus({ cause: 'unavailable', attempt: this.reconnectAttempts, retryAt: null });
    this.connect();
  }

  send(message: ClientMessage): void {
    if (this.ws?.readyState === SOCKET_OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      // Mutations are only valid for the live connection and its confirmed revision.
      if (LIVE_CONNECTION_COMMANDS.has(message.type))
        throw new Error('Office mutations require a connected transport');
      // Queue messages while connecting (flushed in onopen)
      this.pendingMessages.push(message);
    }
  }

  onMessage(handler: (message: ServerMessage) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /**
   * Deliver an externally-sourced message to all handlers, as if it had arrived
   * over the socket. Used in Vite dev mode to bridge `browserMock`'s injected
   * `window` messages (there is no real server to connect to in dev).
   */
  deliver(message: ServerMessage): void {
    for (const handler of this.handlers) handler(message);
  }

  onStateChange(handler: (state: TransportState) => void): () => void {
    this.stateHandlers.push(handler);
    return () => {
      this.stateHandlers = this.stateHandlers.filter((h) => h !== handler);
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.handlers = [];
    this.pendingMessages = [];
    this.setState(TRANSPORT_STATE_DISCONNECTED);
    this.stateHandlers = [];
  }

  private scheduleReconnect(): void {
    // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
    const delay = Math.min(OFFICE_RETRY_BASE_MS * 2 ** this.reconnectAttempts, OFFICE_RETRY_MAX_MS);
    this.reconnectAttempts++;
    setConnectionStatus({
      cause: 'unavailable',
      attempt: this.reconnectAttempts,
      retryAt: Date.now() + delay,
    });
    console.log(
      `[Transport] WebSocket reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      setConnectionStatus({ cause: 'unavailable', attempt: this.reconnectAttempts, retryAt: null });
      this.connect();
    }, delay);
  }
}
