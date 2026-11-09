import * as fs from 'node:fs';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClientMessage, ServerMessage } from '../../core/src/messages.js';
import type { MessageTransport, TransportState } from '../../core/src/transport.js';
import { FEATURE_PLAN_TIMEOUT_MS } from '../src/constants.js';
import { FeaturePlanController } from '../src/office/featurePlanController.js';
import { planDecisionText } from '../src/office/featurePlanPresentation.js';
import { planSnapshot as snapshot } from './fixtures/featurePlan.js';

vi.mock('../src/transport/index.js', () => ({ transport: {} }));

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
    expect(html).not.toMatch(/<(script|img)\b|href="javascript:/);
    expect(html).not.toContain('Sección ausente');
    const footer = html.slice(html.indexOf('<footer'));
    expect(footer).toContain('Este plan no incluye pruebas');
    expect(footer).toContain('Aprobar sin ellas es tu decisión');
    expect(footer).toContain('disabled=""');
    expect(html).toContain('Solo lectura');
    expect(html).toContain('Crear resumen');
    expect(html).toContain('Depende de Crear resumen');
    const disclosures = html.match(/<details>.*?<\/details>/gs) ?? [];
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]).toContain('apiVersion:');
    expect(html.replace(/<details>.*?<\/details>/gs, '')).not.toContain('apiVersion:');
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(footer).toContain('Revisión aaaaaaaa');
    expect(footer).toContain(`title="${'a'.repeat(64)}"`);
    const css = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.feature-plan-dialog\s*\{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.feature-plan-decision\s*\{[^}]*position: sticky;/);
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
    response.plan!.approvalState = 'changed';
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
    expect(html).toContain('El plan cambió después de la aprobación');
    expect(html).toContain('Aprobar plan');
    expect(html).not.toContain('Plan aprobado');
  });
});

describe('SA-128 real approval causes', () => {
  it.each([
    ['approved', 'Esta revisión del plan ya está aprobada'],
    ['changed', 'El plan cambió después de la aprobación'],
    ['unbound', 'todavía no tiene aprobación registrada'],
    ['finished', 'Feature finalizada. No necesita aprobación'],
    ['merged', 'Feature integrada. No necesita aprobación'],
  ] as const)('describes %s from operational state', (state, copy) => {
    const response = snapshot('r');
    response.plan!.approvalState = state;
    expect(planDecisionText(response)).toContain(copy);
  });
  it.each([
    ['read_only', 'La conexión no tiene privilegios'],
    ['managed_process', 'servidor se ejecuta como proceso gestionado'],
    ['unsupported_adapter', 'Este adapter no admite'],
    ['stale_revision', 'revisión mostrada está desactualizada'],
  ] as const)('describes %s without guessing token state', (block, copy) => {
    const response = snapshot('r', false);
    response.approvalBlock = block;
    expect(planDecisionText(response)).toContain(copy);
  });
  it.each(['finished', 'merged'] as const)(
    'hides approval requests and decision warnings on %s work',
    async (state) => {
      const response = snapshot('r', false);
      response.plan!.approvalState = state;
      response.plan!.specApproved = true;
      response.approvalBlock = 'managed_process';
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
      expect(html).toContain('No necesita aprobación');
      expect(html).not.toMatch(
        /no está aprobado|Aprobar plan|es tu decisión|privilegios|proceso gestionado/,
      );
    },
  );
});

describe('SA-111 plan notices', () => {
  it('clears a read error once a manual refresh loads the plan', () => {
    const sent: { requestId: string }[] = [];
    const controller = new FeaturePlanController(
      {
        state: 'connected',
        send: (message: { requestId: string }) => sent.push(message),
        onMessage: () => () => {},
        onStateChange: () => () => {},
      } as unknown as ConstructorParameters<typeof FeaturePlanController>[0],
      'P',
      'FEAT-001',
    );
    const reply = (errorCode: string | null) =>
      controller.receive({
        type: 'featurePlanSnapshot',
        projectId: 'P',
        key: 'FEAT-001',
        requestId: sent[sent.length - 1].requestId,
        plan: null,
        canApprove: false,
        errorCode,
      } as Parameters<typeof controller.receive>[0]);
    controller.refresh();
    reply('unavailable');
    expect(controller.getSnapshot().notice).toContain('No se pudo leer');
    controller.refresh();
    reply(null);
    expect(controller.getSnapshot().notice).toBe('');
  });
});
