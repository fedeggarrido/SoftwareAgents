import type { ReactNode } from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';

import { setOfficeAccess } from '../src/office/accessStore.js';
import { setConnectionStatus } from '../src/office/connectionStatus.js';
import { OfficeRecoveryContext } from '../src/office/recoveryActions.js';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  retry: vi.fn(),
  actions: new Map<string, () => void>(),
  state: 'reconnecting',
}));
vi.mock('../src/transport/index.js', () => ({
  transport: {
    get state() {
      return mocks.state;
    },
    onStateChange: () => () => {},
    send: mocks.send,
    reconnect: mocks.retry,
  },
}));
vi.mock('../src/runtime.js', () => ({ isBrowserRuntime: true }));
vi.mock('../src/components/ui/Button.js', () => ({
  Button: ({ onClick, children }: { onClick: () => void; children: ReactNode }) => {
    mocks.actions.set(String(children), onClick);
    return createElement('button', { onClick }, children);
  },
}));

afterEach(() => {
  mocks.actions.clear();
  mocks.send.mockClear();
  mocks.retry.mockClear();
  mocks.state = 'reconnecting';
  setOfficeAccess(null);
  setConnectionStatus({ cause: 'unavailable', attempt: 0, retryAt: null });
});

it('offers immediate retry and keeps the only startup command in collapsed Details', async () => {
  const path = '../src/components/OfficeConnectionHelp.js';
  const { OfficeConnectionHelp } = await import(path);
  setConnectionStatus({ cause: 'unavailable', attempt: 2, retryAt: Date.now() + 5000 });
  const html = renderToStaticMarkup(createElement(OfficeConnectionHelp));
  expect(html).toContain('próximo intento en 5s');
  expect(html).toContain('La oficina está cerrada en tu ordenador');
  expect(html).toContain('<details><summary>Detalles</summary>');
  expect(html).toContain('npx pixel-agents');
  expect(html).not.toContain('terminal');
  mocks.actions.get('Reintentar ahora')!();
  expect(mocks.retry).toHaveBeenCalledOnce();
});

it('opens the existing preparation form and Settings through their app callbacks', async () => {
  const path = '../src/components/OfficeRecoveryActions.js';
  const { OfficeRecoveryActions } = await import(path);
  const recovery = { openSettings: vi.fn(), prepareProject: vi.fn() };
  renderToStaticMarkup(
    createElement(
      OfficeRecoveryContext,
      { value: recovery },
      createElement(OfficeRecoveryActions, { project: true }),
    ),
  );
  mocks.actions.get('Preparar proyecto')!();
  mocks.actions.get('Abrir Settings')!();
  expect(recovery.prepareProject).toHaveBeenCalledOnce();
  expect(recovery.openSettings).toHaveBeenCalledOnce();
});

it('closing and finishing the tour persist dismissal without granting consent', async () => {
  const path = '../src/hooks/useIntroTour.js';
  const { useIntroTour } = await import(path);
  let close = () => {};
  const dismiss = vi.fn();
  function Tour() {
    close = useIntroTour({
      consentRequest: null,
      hooksInstalled: {},
      hooksStatusSeq: {},
      dismissConsentRequest: dismiss,
    }).onClose;
    return null;
  }
  renderToStaticMarkup(createElement(Tour));
  close();
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith({ type: 'setHooksInfoShown' });
  expect(dismiss).toHaveBeenCalledOnce();
});

it.each([
  [true, null, true],
  [true, 'managed_process', false],
  [false, 'token_required', false],
] as const)(
  'offers revocation only to a connected human operator (%s, %s)',
  async (privileged, reason, visible) => {
    const path = '../src/components/SettingsModal.js';
    const { SettingsModal } = await import(path);
    setOfficeAccess({ type: 'officeAccess', privileged, reason });
    setConnectionStatus({ cause: 'unavailable', state: 'connected', attempt: 0, retryAt: null });
    mocks.state = 'connected';
    const noop = () => {};
    const html = renderToStaticMarkup(
      createElement(SettingsModal, {
        isOpen: true,
        onClose: noop,
        isDebugMode: false,
        onToggleDebugMode: noop,
        alwaysShowOverlay: false,
        onToggleAlwaysShowOverlay: noop,
        ghostHeadlessAgents: false,
        onToggleGhostHeadlessAgents: noop,
        externalAssetDirectories: [],
        watchAllSessions: false,
        onToggleWatchAllSessions: noop,
        hooksInstalled: false,
        onToggleHooksEnabled: noop,
        showAreas: false,
        onToggleShowAreas: noop,
        showAreasAvailable: false,
        onExportLayout: noop,
        onImportLayout: noop,
      }),
    );
    expect(html.includes('Revocar acceso de esta pestaña')).toBe(visible);
    expect(html).toContain('Preparar proyecto');
  },
);
