import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IDEA_QUESTIONS } from '../../core/src/ideaInterview.js';
import type { ClientMessage, ExecutorState } from '../../core/src/messages.js';
import { EXECUTOR_TOGGLE_TIMEOUT_MS } from '../src/constants.js';
import { bindExtensionTransportLifecycle } from '../src/hooks/extensionTransportLifecycle.js';
import { getOfficeAccess, officeAccessView, setOfficeAccess } from '../src/office/accessStore.js';
import { type PendingAgent, reconcileExistingAgents } from '../src/office/engine/existingAgents.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import {
  applyExecutorState,
  emptyExecutorStore,
  getExecutorStore,
  sendExecutorCommand,
  setExecutorStore,
  startLevelToggle,
  startToggle,
} from '../src/office/executorStore.js';
import { WebSocketTransport } from '../src/transport/webSocketTransport.js';

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const state: ExecutorState = {
  type: 'executorState',
  projectId: 'softwareagents',
  revision: 'r1',
  sequence: 0,
  observedAt: 1,
  canManage: true,
  configurationStatus: 'ready',
  executors: [
    {
      executorId: 'claude',
      enabled: true,
      eligible: true,
      reasonCodes: [],
      installation: 'ready',
      authentication: 'ready',
      version: '1',
      levels: ['standard'],
      catalogLevels: ['standard', 'deep'],
      quotaGate: 'allow',
      activeExecutions: 0,
      concurrencyLimit: 1,
      checkedAt: 1,
      staleAfter: 100,
    },
  ],
};

describe('executor transport regressions (DOM-free)', () => {
  let transport: WebSocketTransport;
  let stop: (() => void) | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    FakeSocket.instances = [];
    setExecutorStore(applyExecutorState(emptyExecutorStore(), state));
    transport = new WebSocketTransport('ws://office/ws');
    transport.connect();
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
    transport.dispose();
    setExecutorStore(emptyExecutorStore());
    setOfficeAccess(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each(['setExecutorEnabled', 'setExecutorLevels'] as const)(
    'rejects %s offline and never replays it, while other messages still queue',
    (type) => {
      const message: ClientMessage =
        type === 'setExecutorEnabled'
          ? {
              type,
              projectId: state.projectId,
              executorId: 'claude',
              enabled: false,
              requestId: 'req',
              expectedRevision: 'r1',
            }
          : {
              type,
              projectId: state.projectId,
              executorId: 'claude',
              levels: ['deep'],
              requestId: 'req',
              expectedRevision: 'r1',
            };
      expect(() => transport.send(message)).toThrow(/connected/);
      transport.send({ type: 'requestExecutorState', projectId: state.projectId });
      FakeSocket.instances[0].open();
      expect(FakeSocket.instances[0].sent).toEqual([
        { type: 'requestExecutorState', projectId: state.projectId },
      ]);
      transport.send(message);
      expect(FakeSocket.instances[0].sent.at(-1)).toEqual(message);
      FakeSocket.instances[0].close();
      expect(() => transport.send(message)).toThrow(/connected/);
      transport.send({ type: 'requestExecutorState', projectId: state.projectId });
      vi.advanceTimersByTime(1000);
      FakeSocket.instances[1].open();
      expect(FakeSocket.instances[1].sent).toEqual([
        { type: 'requestExecutorState', projectId: state.projectId },
      ]);
    },
  );

  it.each(['availability', 'levels'])(
    'reports a failed %s send in the store and resyncs',
    (kind) => {
      const message =
        kind === 'levels'
          ? startLevelToggle('claude', 'deep', true)!
          : startToggle('claude', false)!;
      sendExecutorCommand(message, transport);
      expect(getExecutorStore().pending.claude).toBeUndefined();
      expect(getExecutorStore().errors.claude).toMatch(/Sin conexión/);
      expect(getExecutorStore().needsSnapshot).toBe(true);
      FakeSocket.instances[0].open();
      expect(FakeSocket.instances[0].sent).toEqual([
        { type: 'requestExecutorState', projectId: state.projectId },
      ]);
      setExecutorStore(applyExecutorState(getExecutorStore(), { ...state, sequence: 1 }));
      expect(getExecutorStore().errors.claude).toBeUndefined();
    },
  );

  it('SA-109 never queues a draft if the socket closes before send', () => {
    FakeSocket.instances[0].open();
    FakeSocket.instances[0].readyState = 3;
    const message: ClientMessage = {
      type: 'submitIdea',
      projectId: 'P',
      requestId: 'idea',
      text: 'untrusted idea',
      answers: IDEA_QUESTIONS.map((question) => ({
        questionId: question.id,
        choice: 'decide',
        text: '',
      })),
    };
    expect(() => transport.send(message)).toThrow(/connected/);
    FakeSocket.instances[0].close();
    vi.advanceTimersByTime(1000);
    FakeSocket.instances[1].open();
    expect(FakeSocket.instances[1].sent).toEqual([]);
  });

  it('rejects project preparation while connecting or CLOSING and never replays it', () => {
    const message: ClientMessage = {
      type: 'prepareProject',
      requestId: 'prepare',
      name: 'Project',
    };
    expect(() => transport.send(message)).toThrow(/connected/);
    const socket = FakeSocket.instances[0];
    socket.open();
    expect(socket.sent).toEqual([]);
    socket.readyState = 2;
    expect(transport.state).toBe('connected');
    expect(() => transport.send(message)).toThrow(/connected/);
    transport.send({ type: 'requestIdeas', requestId: 'refresh' });
    socket.close();
    vi.advanceTimersByTime(1000);
    FakeSocket.instances[1].open();
    expect(FakeSocket.instances[1].sent).toEqual([{ type: 'requestIdeas', requestId: 'refresh' }]);
    transport.send(message);
    expect(FakeSocket.instances[1].sent.at(-1)).toEqual(message);
  });

  it('recovers when the socket closes just before send, while its state still says connected', () => {
    FakeSocket.instances[0].open();
    const message = startToggle('claude', false)!;
    FakeSocket.instances[0].readyState = 3;
    sendExecutorCommand(message, transport);
    expect(getExecutorStore().pending.claude).toBeUndefined();
    expect(getExecutorStore().errors.claude).toMatch(/Sin conexión/);
    FakeSocket.instances[0].close();
    vi.advanceTimersByTime(1000);
    FakeSocket.instances[1].open();
    expect(FakeSocket.instances[1].sent).toEqual([
      { type: 'requestExecutorState', projectId: state.projectId },
    ]);
  });

  it('keeps access unconfirmed from disconnect until the next officeAccess answer', () => {
    stop = bindExtensionTransportLifecycle(transport);
    const unsubscribe = transport.onMessage((message) => {
      if (message.type === 'officeAccess') setOfficeAccess(message);
    });
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.onmessage?.({
      data: JSON.stringify({ type: 'officeAccess', privileged: true, reason: null }),
    });
    expect(officeAccessView(getOfficeAccess(), false).label).toBe('Operador');
    socket.close();
    expect(officeAccessView(getOfficeAccess(), false)).toMatchObject({
      label: 'Reconectando…',
      pending: true,
      blocked: false,
    });
    vi.advanceTimersByTime(1000);
    const next = FakeSocket.instances[1];
    next.open();
    expect(officeAccessView(getOfficeAccess(), false).pending).toBe(true);
    next.onmessage?.({
      data: JSON.stringify({ type: 'officeAccess', privileged: false, reason: 'token_required' }),
    });
    expect(officeAccessView(getOfficeAccess(), false)).toMatchObject({
      label: 'Solo lectura',
      pending: false,
      blocked: true,
    });
    unsubscribe();
  });

  it('repeats capability handshakes on every reconnect, without doubling the initial handshake', () => {
    stop = bindExtensionTransportLifecycle(transport);
    const unsubscribe = transport.onMessage((message) => {
      if (message.type === 'executorState')
        setExecutorStore(applyExecutorState(getExecutorStore(), message));
    });
    for (let i = 0; i < 3; i++) {
      const socket = FakeSocket.instances[i];
      socket.open();
      expect(socket.sent).toEqual([{ type: 'webviewReady', capabilities: ['executorControls'] }]);
      socket.onmessage?.({ data: JSON.stringify({ ...state, revision: `r${i}`, sequence: 0 }) });
      expect(getExecutorStore().state?.revision).toBe(`r${i}`);
      expect(getExecutorStore().needsSnapshot).toBe(false);
      socket.close();
      expect(getExecutorStore().needsSnapshot).toBe(true);
      vi.advanceTimersByTime(1000);
    }
    unsubscribe();
  });

  it('expires and recovers pending commands without mounting a panel, and cleans up its timer', () => {
    FakeSocket.instances[0].open();
    stop = bindExtensionTransportLifecycle(transport);
    startToggle('claude', false);
    vi.advanceTimersByTime(EXECUTOR_TOGGLE_TIMEOUT_MS);
    expect(getExecutorStore().pending.claude).toBeUndefined();
    expect(getExecutorStore().errors.claude).toMatch(/Sin respuesta/);
    expect(FakeSocket.instances[0].sent.at(-1)).toEqual({
      type: 'requestExecutorState',
      projectId: state.projectId,
    });
    stop();
    stop = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a repeated full roster preserves characters, adds only missing ones and retains metadata', () => {
    const characters = new Map<number, { palette?: number; seat?: string }>();
    const addAgent = vi.fn((id: number, palette?: number, _hue?: number, seat?: string) => {
      characters.set(id, { palette, seat });
    });
    const office = { characters, addAgent, setHeadless: vi.fn() };
    const pending: PendingAgent[] = [];
    const meta = { 1: { palette: 2, seatId: 'desk' } };
    reconcileExistingAgents(office, [1], meta, {}, true, pending);
    reconcileExistingAgents(office, [1, 2], meta, {}, true, pending);
    reconcileExistingAgents(office, [1, 2], meta, {}, true, pending);
    expect(addAgent).toHaveBeenCalledTimes(2);
    expect(characters.size).toBe(2);
    expect(characters.get(1)).toEqual({ palette: 2, seat: 'desk' });
  });

  it.each([false, true])(
    'replaying roster and layout preserves the real office (layout initially ready: %s)',
    (ready) => {
      const office = new OfficeState();
      let pending: PendingAgent[] = [];
      let layoutReady = ready;
      const meta = { 1: { palette: 2 }, 2: { palette: 3 } };
      for (let i = 0; i < 3; i++) {
        reconcileExistingAgents(office, [1, 2], meta, {}, layoutReady, pending, { 1: true });
        const first = office.characters.get(1);
        office.rebuildFromLayout(office.getLayout());
        for (const p of pending) {
          office.addAgent(p.id, p.palette, p.hueShift, p.seatId, true, p.folderName);
          if (p.isHeadless) office.setHeadless(p.id, true);
        }
        pending = [];
        layoutReady = true;
        expect(office.characters.size).toBe(2);
        expect(office.characters.get(1)?.palette).toBe(2);
        if (first) expect(office.characters.get(1)).toBe(first);
      }
    },
  );
});
