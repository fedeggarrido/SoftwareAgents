import * as fs from 'node:fs';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FEATURE_PLAN_SECTIONS } from '../../core/src/featurePlan.js';
import type { ClientMessage, FeaturePlanSnapshot, ServerMessage } from '../../core/src/messages.js';
import type { MessageTransport, TransportState } from '../../core/src/transport.js';
import { FEATURE_PLAN_TIMEOUT_MS } from '../src/constants.js';
import { FeaturePlanController } from '../src/office/featurePlanController.js';

vi.mock('../src/transport/index.js', () => ({ transport: {} }));
const snapshot = (requestId: string, canApprove = true): FeaturePlanSnapshot => ({
  type: 'featurePlanSnapshot',
  projectId: 'P',
  key: 'FEAT-001',
  requestId,
  canApprove,
  errorCode: null,
  plan: {
    key: 'FEAT-001',
    title: '<script>alert(1)</script>',
    revision: 'a'.repeat(64),
    specSha: 'b'.repeat(40),
    specApproved: false,
    approved: false,
    sections: FEATURE_PLAN_SECTIONS.map((section) => ({
      ...section,
      content:
        section.id === 'requirements'
          ? '<img src=x onerror=alert(1)>\n[enlace](javascript:alert(1))'
          : null,
    })),
  },
});

function harness() {
  let receive: (message: ServerMessage) => void = () => {};
  let stateChanged: (state: TransportState) => void = () => {};
  const wire: MessageTransport = {
    send: vi.fn<(message: ClientMessage) => void>(),
    state: 'connected',
    ready: Promise.resolve(),
    dispose() {},
    onMessage(handler) {
      receive = handler;
      return () => {
        receive = () => {};
      };
    },
    onStateChange(handler) {
      stateChanged = handler;
      return () => {
        stateChanged = () => {};
      };
    },
  };
  const controller = new FeaturePlanController(wire, 'P', 'FEAT-001');
  const stop = controller.start();
  const send = vi.mocked(wire.send);
  const read = () =>
    send.mock.calls.at(-1)![0] as Extract<ClientMessage, { type: 'requestFeaturePlan' }>;
  return {
    controller,
    wire,
    send,
    stop,
    read,
    receive: (message: ServerMessage) => receive(message),
    stateChanged: (state: TransportState) => stateChanged(state),
  };
}
afterEach(() => vi.useRealTimers());

describe('SA-111 plan approval', () => {
  it('keeps read-only controls inert and accepts only the current Project, feature and read', () => {
    const h = harness();
    const response = snapshot(h.read().requestId, false);
    for (const changed of [{ projectId: 'Q' }, { key: 'FEAT-002' }, { requestId: 'old' }]) {
      h.receive({ ...response, ...changed });
      expect(h.controller.getSnapshot().snapshot).toBeNull();
    }
    h.receive(response);
    h.controller.approve();
    expect(h.send).toHaveBeenCalledTimes(1);
    h.stop();
  });
  it('sends the displayed revision once for double clicks and refreshes a stale plan without resubmitting approval', () => {
    const h = harness();
    h.receive(snapshot(h.read().requestId));
    h.controller.approve();
    h.controller.approve();
    const approval = h.send.mock.calls.at(-1)![0];
    expect(approval).toMatchObject({ type: 'approveFeaturePlan', revision: 'a'.repeat(64) });
    expect(h.send).toHaveBeenCalledTimes(2);
    if (approval.type !== 'approveFeaturePlan') throw new Error('missing approval');
    const result = {
      ...approval,
      type: 'featureApprovalResult' as const,
      status: 'rejected' as const,
      errorCode: 'stale_revision' as const,
    };
    h.receive({ ...result, revision: 'old' });
    expect(h.controller.getSnapshot().pending).toBe(true);
    h.receive(result);
    expect(h.controller.getSnapshot().notice).toContain('ha cambiado');
    expect(h.read().type).toBe('requestFeaturePlan');
    h.controller.approve();
    expect(h.send).toHaveBeenCalledTimes(3);
    h.receive(snapshot(h.read().requestId));
    expect(h.controller.getSnapshot().pending).toBe(false);
    expect(
      h.send.mock.calls.filter(([message]) => message.type === 'approveFeaturePlan'),
    ).toHaveLength(1);
    h.stop();
  });
  it('invalidates approval on disconnect and requires a fresh read after timeout', () => {
    vi.useFakeTimers();
    const h = harness();
    const old = snapshot(h.read().requestId);
    h.receive(old);
    h.controller.approve();
    h.stateChanged('reconnecting');
    expect(h.controller.getSnapshot().snapshot).toBeNull();
    h.controller.approve();
    expect(h.send).toHaveBeenCalledTimes(2);
    h.stateChanged('connected');
    h.receive(old);
    expect(h.controller.getSnapshot().snapshot).toBeNull();
    vi.advanceTimersByTime(FEATURE_PLAN_TIMEOUT_MS);
    expect(h.controller.getSnapshot().notice).toContain('no se pudo confirmar');
    h.controller.approve();
    expect(h.send).toHaveBeenCalledTimes(3);
    h.stop();
  });
  it('renders missing sections explicitly and hostile plan text as inert text at phone-compatible width', async () => {
    const componentPath = '../src/components/FeaturePlanDialog.js';
    const { FeaturePlanView } = await import(componentPath);
    const view = { snapshot: snapshot('r', false), pending: false, loading: false, notice: '' };
    const html = renderToStaticMarkup(
      createElement(FeaturePlanView, {
        featureKey: 'FEAT-001',
        view,
        onClose() {},
        onApprove() {},
        onRefresh() {},
      }),
    );
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
    expect(html).not.toMatch(/<(script|img|a)\b/);
    expect(html.match(/Sección ausente/g)).toHaveLength(6);
    expect(html).not.toContain('Aprobar plan');
    expect(html).toContain('Solo lectura');
    const css = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    expect(css).toMatch(
      /\.feature-plan-dialog\s*\{[^}]*width: min\(760px, calc\(100vw - 32px\)\);[^}]*min-width: 0;/,
    );
  });
  it('shows the read-only message and no plan after a denied read', async () => {
    const h = harness();
    h.receive({ ...snapshot(h.read().requestId, false), plan: null, errorCode: 'denied' });
    h.controller.approve();
    expect(h.send).toHaveBeenCalledTimes(1);
    const componentPath = '../src/components/FeaturePlanDialog.js';
    const { FeaturePlanView } = await import(componentPath);
    const html = renderToStaticMarkup(
      createElement(FeaturePlanView, {
        featureKey: 'FEAT-001',
        view: h.controller.getSnapshot(),
        onClose() {},
        onApprove() {},
        onRefresh() {},
      }),
    );
    expect(html).toContain(
      'Solo lectura. La aprobación requiere una conexión privilegiada del operador.',
    );
    expect(html).not.toContain('Aprobar plan');
    expect(html).not.toContain('Requisitos');
    h.stop();
  });
  it('distinguishes FeatureSpec approval from the displayed plan and enables a new human approval', async () => {
    const response = snapshot('r');
    response.plan!.specApproved = true;
    const componentPath = '../src/components/FeaturePlanDialog.js';
    const { FeaturePlanView } = await import(componentPath);
    const html = renderToStaticMarkup(
      createElement(FeaturePlanView, {
        featureKey: 'FEAT-001',
        view: { snapshot: response, pending: false, loading: false, notice: '' },
        onClose() {},
        onApprove() {},
        onRefresh() {},
      }),
    );
    expect(html).toContain('FeatureSpec aprobada; este plan ha cambiado y no está aprobado');
    expect(html).toContain('Aprobar plan');
    expect(html).not.toContain('Plan aprobado');
  });
});
