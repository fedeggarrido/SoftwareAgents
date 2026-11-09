import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { officeAccessView, setOfficeAccess } from '../src/office/accessStore.js';

const runtime = vi.hoisted(() => ({ browser: true }));
vi.mock('../src/runtime.js', () => ({
  get isBrowserRuntime() {
    return runtime.browser;
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
  runtime.browser = true;
});

describe('SA-116 permanent office mode', () => {
  it('shows read-only mode and actionable Spanish instructions in its tooltip', async () => {
    setOfficeAccess({ type: 'officeAccess', privileged: false, reason: 'token_required' });
    const html = await indicator();
    expect(html).toContain('Solo lectura');
    expect(html).toContain('title="Para preparar el proyecto');
    expect(html).toContain('inicia pixel-agents tú mismo en tu terminal');
    expect(html).toContain('URL con token que imprime');
    expect(html).not.toContain('role="alert"');
  });

  it('explains the reload consequence only for a standalone operator', async () => {
    setOfficeAccess({ type: 'officeAccess', privileged: true, reason: null });
    const html = await indicator();
    expect(html).toContain('Operador');
    expect(html).toContain('Recargar la página quita el modo operador');
    expect(html).toContain('vuelve a abrir la URL de la terminal');
    expect(officeAccessView(null, false).blocked).toBe(true);
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
