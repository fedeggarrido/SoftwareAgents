import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { officeAccessView, setOfficeAccess } from '../src/office/accessStore.js';
import { getConnectionStatus, setConnectionStatus } from '../src/office/connectionStatus.js';

const runtime = vi.hoisted(() => ({ browser: true }));
vi.mock('../src/runtime.js', () => ({
  get isBrowserRuntime() {
    return runtime.browser;
  },
}));
vi.mock('../src/transport/index.js', () => ({
  transport: {
    get state() {
      return getConnectionStatus().state ?? 'connected';
    },
    onStateChange: () => () => {},
    reconnect: vi.fn(),
  },
}));
// Keep TSX outside the node-only test TypeScript project.
const indicatorPath = '../src/components/OfficeModeIndicator.js';
async function indicator() {
  const { OfficeModeIndicator } = await import(indicatorPath);
  return renderToStaticMarkup(createElement(OfficeModeIndicator));
}
afterEach(() => {
  setOfficeAccess(null);
  setConnectionStatus({ cause: 'unavailable', attempt: 0, retryAt: null });
  runtime.browser = true;
});

describe('SA-116 permanent office mode', () => {
  it('warns in Settings when persistence is unavailable', async () => {
    setOfficeAccess({ type: 'officeAccess', privileged: true, reason: null, persistent: false });
    expect(
      officeAccessView(
        { type: 'officeAccess', privileged: true, reason: null, persistent: false },
        false,
      ).explanation,
    ).toContain('dura mientras Pixel Agents siga abierto');
    const settingsPath = '../src/components/SettingsModal.js';
    const { SettingsModal } = await import(settingsPath);
    const html = renderToStaticMarkup(
      createElement(SettingsModal, {
        isOpen: true,
        onClose: () => {},
        externalAssetDirectories: [],
      }),
    );
    expect(html).toContain('no sobrevivirá a los reinicios');
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/<details[^>]*><summary>Detalles<\/summary>/);
    expect(html).toContain('Copiar token para CLI');
  });
  it.each([
    ['unavailable', 'reconnecting', 'La oficina está cerrada en tu ordenador'],
    ['unauthorized', 'disconnected', 'El acceso de esta pestaña ha caducado'],
    ['origin', 'disconnected', 'ha rechazado el origen'],
  ] as const)(
    'names the office connection and explains %s in the badge',
    async (cause, state, text) => {
      setOfficeAccess(null);
      setConnectionStatus({
        cause,
        state,
        attempt: state === 'reconnecting' ? 1 : 0,
        retryAt: null,
      });
      const html = await indicator();
      expect(html).toContain('Reintentar ahora');
      expect(html).toContain(text);
    },
  );
  it('shows neutral reconnecting help until the handshake confirms access', async () => {
    setOfficeAccess(null);
    const html = await indicator();
    expect(html).toContain('Conectando con la oficina…');
    expect(html).not.toContain('Solo lectura');
    expect(html).not.toContain('URL con token');
  });

  it('shows read-only mode and actionable Spanish instructions in its tooltip', async () => {
    setOfficeAccess({ type: 'officeAccess', privileged: false, reason: 'token_required' });
    const html = await indicator();
    expect(html).toContain('Solo lectura');
    expect(html).toContain('Abre Pixel Agents en tu ordenador');
    expect(html).not.toContain('terminal');
    expect(html).not.toContain('role="alert"');
  });

  it('explains the reload consequence only for a standalone operator', async () => {
    setOfficeAccess({ type: 'officeAccess', privileged: true, reason: null });
    const html = await indicator();
    expect(html).toContain('Operador');
    expect(html).toContain('recupera la conexión cuando reinicias Pixel Agents');
    expect(html).toContain('revocar su acceso desde Settings');
    expect(officeAccessView(null, false)).toMatchObject({
      label: 'Conectando con la oficina…',
      blocked: false,
      pending: true,
    });
  });

  it('distinguishes an authenticated connection running under an agent', async () => {
    setOfficeAccess({ type: 'officeAccess', privileged: true, reason: 'managed_process' });
    const html = await indicator();
    expect(html).toContain('Operador · proceso gestionado');
    expect(html).toContain('Esta oficina se inició desde un agente');
    expect(
      officeAccessView({ type: 'officeAccess', privileged: true, reason: 'managed_process' }, false)
        .blocked,
    ).toBe(true);
  });

  it('shows Operador in VS Code without a URL token or a standalone handshake', async () => {
    runtime.browser = false;
    const html = await indicator();
    expect(html).toContain('Operador');
    expect(html).toContain('VS Code proporciona el modo operador');
    expect(html).not.toContain('Recargar');
    expect(officeAccessView(null, true).blocked).toBe(false);
  });
});
