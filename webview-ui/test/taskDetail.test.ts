import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClientMessage, ServerMessage, TaskDetailSnapshot } from '../../core/src/messages.js';
import {
  TASK_CHANGE_TEXT,
  taskChangeImpact,
  taskChangePolicy,
} from '../../core/src/taskChangePolicy.js';
import type { MessageTransport, TransportState } from '../../core/src/transport.js';
import { FEATURE_PLAN_TIMEOUT_MS } from '../src/constants.js';
import { taskStateExplanation } from '../src/office/statusPresentation.js';
import { TaskDetailController } from '../src/office/taskDetailController.js';
import { taskPrDescription, taskTitle } from '../src/office/taskDetailPresentation.js';

describe('SA-143 change policy', () => {
  it.each(['DRAFT', 'ANALYSIS', 'READY', 'QUEUED'])('sends %s back for spec approval', (state) => {
    expect(taskChangePolicy(state)).toBe('revise_spec');
  });
  it.each([
    'LEASED',
    'RUNNING',
    'ACTIVE',
    'REVIEW',
    'AWAITING_REVIEW',
    'QA',
    'BLOCKED',
    'WAITING_HUMAN',
    'WAITING_QUOTA',
    'WAITING_DEPENDENCY',
    'FAILED_RETRYABLE',
  ])('records %s for a safe point', (state) => {
    expect(taskChangePolicy(state)).toBe('safe_point');
  });
  it.each(['DONE', 'VERIFIED', 'CANCELLED', 'FAILED', 'FAILED_FINAL'])(
    'creates follow-up work for %s',
    (state) => {
      expect(taskChangePolicy(state)).toBe('follow_up');
    },
  );
  it('fails closed for a new phase and explains each supported state in Spanish', () => {
    expect(taskChangePolicy('NEW_PHASE')).toBeUndefined();
    for (const state of [
      'DRAFT',
      'ANALYSIS',
      'READY',
      'QUEUED',
      'LEASED',
      'RUNNING',
      'ACTIVE',
      'REVIEW',
      'AWAITING_REVIEW',
      'QA',
      'BLOCKED',
      'WAITING_HUMAN',
      'WAITING_QUOTA',
      'WAITING_DEPENDENCY',
      'FAILED_RETRYABLE',
      'DONE',
      'VERIFIED',
      'CANCELLED',
      'FAILED',
      'FAILED_FINAL',
    ]) {
      expect(taskStateExplanation(state)).toMatch(/\.$/);
      expect(taskStateExplanation(state)).not.toContain(state);
    }
    expect(TASK_CHANGE_TEXT.safe_point).toContain('conservando');
  });
  it('lists transitive dependants and feature peers once, including cross-feature dependencies', () => {
    const task = { id: 'A', epic: 'feature', dependsOn: [] };
    const tasks = [
      task,
      { id: 'C', epic: 'other', dependsOn: ['B'] },
      { id: 'B', epic: 'feature', dependsOn: ['A'] },
      { id: 'D', epic: 'feature', dependsOn: [] },
      { id: 'E', epic: 'other', dependsOn: [] },
    ];
    expect(taskChangeImpact(task, tasks).map((entry) => entry.id)).toEqual(['B', 'C', 'D']);
  });
  it('handles old tasks without features and terminates on malformed cyclic data', () => {
    const task = { id: 'A', dependsOn: ['B'] };
    expect(taskChangeImpact(task, [task, { id: 'B', dependsOn: ['A'] }, { id: 'C' }])).toEqual([
      { id: 'B', dependsOn: ['A'] },
    ]);
    expect(taskChangeImpact(task, [task, { id: 'C' }])).toEqual([]);
  });
  it('keeps UUIDs and internal PR states out of the detail labels', () => {
    expect(taskTitle({ id: 'f4712bac-a159-4321-8765-234abc987654', title: 'desconocido' })).toBe(
      'Tarea sin título registrado',
    );
    expect(taskPrDescription({ id: 'A', title: 'A', phase: 'DONE', agentIds: [] })).toContain(
      'aún no tiene',
    );
  });
});

function harness() {
  let receive: (message: ServerMessage) => void = () => {};
  let stateChanged: (state: TransportState) => void = () => {};
  const wire: MessageTransport = {
    send: vi.fn<(message: ClientMessage) => void>(),
    state: 'connected',
    ready: Promise.resolve(),
    dispose() {},
    onMessage(callback) {
      receive = callback;
      return () => {};
    },
    onStateChange(callback) {
      stateChanged = callback;
      return () => {};
    },
  };
  const controller = new TaskDetailController(wire, 'project', 'A');
  const stop = controller.start();
  const send = vi.mocked(wire.send);
  const read = send.mock.calls[0][0];
  if (read.type !== 'requestTaskDetail') throw new Error('Missing task detail read');
  const snapshot: TaskDetailSnapshot = {
    type: 'taskDetailSnapshot',
    projectId: 'project',
    key: 'A',
    requestId: read.requestId,
    errorCode: null,
    detail: {
      item: { id: 'A', title: 'Tarea', phase: 'READY', agentIds: [] },
      description: 'Especificación',
      featureTitle: null,
      origin: null,
      impact: [],
      decisions: [],
      revision: 'a'.repeat(64),
      canChange: true,
    },
  };
  return {
    controller,
    wire,
    send,
    stop,
    snapshot,
    receive: (message: ServerMessage) => receive(message),
    stateChanged: (state: TransportState) => stateChanged(state),
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SA-143 explicit confirmation', () => {
  it('recovers if the socket closes between the connection check and the confirmation send', () => {
    const h = harness();
    h.receive(h.snapshot);
    h.send.mockImplementationOnce(() => {
      throw new Error('Socket closed');
    });
    expect(() => h.controller.confirm('Cambio')).not.toThrow();
    expect(h.controller.getSnapshot()).toMatchObject({ pending: false, detail: null });
    expect(h.controller.getSnapshot().notice).toContain('vuelve a confirmar');
    h.stop();
  });
  it('supports a plain HTTP office where randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    const h = harness();
    h.receive(h.snapshot);
    h.controller.confirm('Cambio');
    expect(h.send.mock.calls[1][0]).toMatchObject({
      type: 'submitTaskChange',
      requestId: expect.stringMatching(/^req-/),
    });
    h.stop();
  });
  it('reuses the request identity when the human retries an uncertain confirmation', () => {
    vi.useFakeTimers();
    const h = harness();
    h.receive(h.snapshot);
    h.controller.confirm('Cambio');
    const first = h.send.mock.calls[1][0];
    vi.advanceTimersByTime(FEATURE_PLAN_TIMEOUT_MS);
    h.controller.refresh();
    const read = h.send.mock.calls.at(-1)![0];
    if (read.type !== 'requestTaskDetail') throw new Error('Missing refresh');
    h.receive({
      ...h.snapshot,
      requestId: read.requestId,
      detail: { ...h.snapshot.detail!, revision: 'b'.repeat(64) },
    });
    h.controller.confirm('Cambio');
    expect(h.send.mock.calls.at(-1)![0]).toEqual(first);
    h.stop();
  });
  it('reads without writing and accepts only a response for this project, task and request', () => {
    const h = harness();
    for (const change of [{ projectId: 'other' }, { key: 'B' }, { requestId: 'old' }])
      h.receive({ ...h.snapshot, ...change });
    expect(h.controller.getSnapshot().detail).toBeNull();
    h.receive(h.snapshot);
    expect(h.send).toHaveBeenCalledTimes(1);
    h.controller.confirm('Edición');
    h.controller.confirm('Edición');
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1][0]).toMatchObject({
      type: 'submitTaskChange',
      revision: 'a'.repeat(64),
      text: 'Edición',
    });
    h.stop();
  });
  it('keeps read-only requests inert', () => {
    const h = harness();
    h.receive({ ...h.snapshot, detail: { ...h.snapshot.detail!, canChange: false } });
    h.controller.confirm('Edición');
    expect(h.send).toHaveBeenCalledTimes(1);
    h.stop();
  });
  it('invalidates confirmation on disconnect, timeout and a stale revision', () => {
    vi.useFakeTimers();
    const h = harness();
    h.receive(h.snapshot);
    h.controller.confirm('Cambio');
    const submitted = h.send.mock.calls[1][0];
    if (submitted.type !== 'submitTaskChange') throw new Error('Missing submission');
    h.receive({
      type: 'taskChangeResult',
      projectId: 'project',
      key: 'A',
      requestId: submitted.requestId,
      followUpKey: null,
      errorCode: 'stale_revision',
    });
    expect(h.controller.getSnapshot().notice).toContain('han cambiado');
    expect(h.controller.getSnapshot().detail).toBeNull();
    expect(
      h.send.mock.calls.filter(([message]) => message.type === 'submitTaskChange'),
    ).toHaveLength(1);
    h.stateChanged('reconnecting');
    h.controller.confirm('Otro');
    expect(h.controller.getSnapshot().detail).toBeNull();
    h.controller.refresh();
    vi.advanceTimersByTime(FEATURE_PLAN_TIMEOUT_MS);
    expect(h.controller.getSnapshot().notice).toContain('No se pudo confirmar');
    h.stop();
  });
});
