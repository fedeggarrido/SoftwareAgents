import type { ReactElement } from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdeasSnapshot, SubmitIdeaResult } from '../../core/src/messages.js';
import { IDEA_REQUEST_TIMEOUT_MS } from '../src/constants.js';
import {
  applyIdeaResult,
  applyIdeasSnapshot,
  emptyIdeasStore,
  getIdeasStore,
  setIdeasStore,
} from '../src/office/ideasStore.js';

// Node-only hook harness. Execute dependency changes and cleanups, including real timers.
// Runtime component paths keep TSX outside tsconfig.node.
const lifecycle = vi.hoisted(() => ({
  state: 'connected',
  text: '',
  send: vi.fn(),
  close: vi.fn(),
  cursor: 0,
  effects: [] as Array<{ dependencies?: readonly unknown[]; cleanup?: () => void }>,
  scheduled: [] as Array<() => void>,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_: unknown, get: () => unknown) => get(),
  useState: () => [
    lifecycle.text,
    (value: string) => {
      lifecycle.text = value;
    },
  ],
  useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
    const index = lifecycle.cursor++;
    const previous = lifecycle.effects[index];
    if (
      previous &&
      dependencies &&
      previous.dependencies &&
      dependencies.length === previous.dependencies.length &&
      dependencies.every((value, i) => Object.is(value, previous.dependencies![i]))
    )
      return;
    lifecycle.scheduled.push(() => {
      previous?.cleanup?.();
      lifecycle.effects[index] = { dependencies, cleanup: effect() || undefined };
    });
  },
}));
vi.mock('../src/transport/index.js', () => ({
  transport: {
    get state() {
      return lifecycle.state;
    },
    onStateChange: () => () => {},
    send: lifecycle.send,
  },
}));
const dialogPath = '../src/components/NewIdeaDialog.js';
const listPath = '../src/components/IdeasList.js';
const snapshot: IdeasSnapshot = {
  type: 'ideasSnapshot',
  requestId: 'r',
  projectId: 'P',
  canSubmit: true,
  errorCode: null,
  ideas: [],
};
const result: SubmitIdeaResult = {
  type: 'submitIdeaResult',
  requestId: 's',
  projectId: 'P',
  status: 'saved',
  errorCode: null,
  idea: {
    key: 'FEAT-001',
    command:
      'pixel-agents feature run FEAT-001 --request .softwareagents/ideas/P/FEAT-001.md --confirm',
  },
};
async function tree(): Promise<ReactElement> {
  const { NewIdeaDialog } = await import(dialogPath);
  lifecycle.cursor = 0;
  return NewIdeaDialog({ onClose: lifecycle.close });
}
async function render() {
  let node = await tree();
  // Effects update the store. Render again to install the matching deadlines.
  while (lifecycle.scheduled.length) {
    const effects = lifecycle.scheduled.splice(0);
    for (const effect of effects) effect();
    node = await tree();
  }
  return renderToStaticMarkup(node);
}
function findAction(node: unknown, text: string): (() => void) | undefined {
  if (Array.isArray(node)) return node.map((child) => findAction(child, text)).find(Boolean);
  if (!node || typeof node !== 'object') return;
  const props = (node as ReactElement<{ children?: unknown; onClick?: () => void }>).props;
  if (props?.children === text && props.onClick) return props.onClick;
  return findAction(props?.children, text);
}
function respond(over: Partial<IdeasSnapshot> = {}) {
  setIdeasStore(
    applyIdeasSnapshot(getIdeasStore(), {
      ...snapshot,
      requestId: getIdeasStore().requestId!,
      ...over,
    }),
  );
}
async function submit() {
  lifecycle.text = 'Una idea literal';
  await render();
  findAction(await tree(), 'Guardar idea')!();
  await render();
}
beforeEach(() => {
  vi.useFakeTimers();
  lifecycle.state = 'connected';
  lifecycle.text = '';
  lifecycle.cursor = 0;
  lifecycle.effects = [];
  lifecycle.scheduled = [];
  lifecycle.send.mockReset();
  lifecycle.close.mockReset();
  setIdeasStore(emptyIdeasStore());
});
afterEach(() => {
  for (const effect of lifecycle.effects) effect.cleanup?.();
  vi.useRealTimers();
});

describe('SA-109 dialog lifecycle and presentation', () => {
  it('requests preparation on mount and renders an accessible editable dialog after the reply', async () => {
    expect(await render()).toContain('Comprobando');
    expect(lifecycle.send).toHaveBeenCalledExactlyOnceWith({
      type: 'requestIdeas',
      requestId: getIdeasStore().requestId,
    });
    respond();
    const html = await render();
    for (const text of [
      'Nueva idea',
      'role="dialog"',
      'aria-modal="true"',
      '<textarea',
      'Tu idea',
      'Guardar idea',
      'shadow-pixel',
      'no inicia ningún trabajo',
    ])
      expect(html).toContain(text);
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
  });

  it.each([
    ['denied', 'Solo lectura'],
    ['missing_manifest', '.softwareagents/project.yaml'],
    ['invalid_manifest', 'no es válido'],
    ['no_project', 'no hay un Project'],
    ['unsupported_adapter', 'VS Code'],
    ['unsafe_storage', 'ruta de ideas'],
  ] as const)('explains %s and retries the actual read', async (errorCode, text) => {
    await render();
    respond({ canSubmit: false, errorCode });
    const html = await render();
    expect(html).toContain(text);
    expect(html).toMatch(/<textarea[^>]*disabled/);
    findAction(await tree(), 'Reintentar lectura de ideas')!();
    expect(lifecycle.send).toHaveBeenCalledTimes(2);
    expect(await render()).toContain('Comprobando');
    respond();
    expect(await render()).not.toMatch(/<textarea[^>]*disabled/);
  });

  it('times out a missing read reply and retries with a fresh correlation id', async () => {
    await render();
    const stale = getIdeasStore().requestId!;
    vi.advanceTimersByTime(IDEA_REQUEST_TIMEOUT_MS);
    expect(await render()).toContain('No se pudieron leer o guardar las ideas');
    findAction(await tree(), 'Reintentar lectura de ideas')!();
    setIdeasStore(applyIdeasSnapshot(getIdeasStore(), { ...snapshot, requestId: stale }));
    expect(await render()).toContain('Comprobando');
    respond();
    expect(await render()).not.toMatch(/<textarea[^>]*disabled/);
  });

  it('times out an unconfirmed submit, retains text and never replays on reconnect', async () => {
    await render();
    respond();
    await submit();
    expect(await render()).toContain('Guardando…');
    findAction(await tree(), 'Cerrar')!();
    expect(lifecycle.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(IDEA_REQUEST_TIMEOUT_MS);
    expect(await render()).toContain('Consulta las ideas pendientes');
    expect(await render()).toContain('Una idea literal');
    lifecycle.state = 'reconnecting';
    await render();
    lifecycle.state = 'connected';
    await render();
    expect(
      lifecycle.send.mock.calls.filter(([message]) => message.type === 'submitIdea'),
    ).toHaveLength(1);
    expect(
      lifecycle.send.mock.calls.filter(([message]) => message.type === 'requestIdeas'),
    ).toHaveLength(2);
    expect(await render()).toContain('Consulta las ideas pendientes');
  });

  it('invalidates a pending submit on disconnect and ignores its late confirmation', async () => {
    await render();
    respond();
    await submit();
    const pending = getIdeasStore().pending!;
    lifecycle.state = 'reconnecting';
    await render();
    setIdeasStore(applyIdeaResult(getIdeasStore(), { ...result, ...pending }));
    expect(await render()).toContain('Consulta las ideas pendientes');
    lifecycle.state = 'connected';
    await render();
    respond();
    expect(await render()).not.toContain('Idea guardada:');
    expect(
      lifecycle.send.mock.calls.filter(([message]) => message.type === 'submitIdea'),
    ).toHaveLength(1);
  });

  it('requests again after reconnecting from an offline mount', async () => {
    lifecycle.state = 'reconnecting';
    expect(await render()).toContain('Sin conexión');
    expect(lifecycle.send).not.toHaveBeenCalled();
    lifecycle.state = 'connected';
    expect(await render()).toContain('Comprobando');
    expect(lifecycle.send).toHaveBeenCalledOnce();
  });

  it('confirms the assigned id and exact command only after the correlated reply', async () => {
    await render();
    respond();
    await submit();
    setIdeasStore(
      applyIdeaResult(getIdeasStore(), {
        ...result,
        ...getIdeasStore().pending!,
        errorCode: 'audit_failed',
      }),
    );
    const html = await render();
    expect(html).toContain('Idea guardada: <strong>FEAT-001</strong>');
    expect(html).toContain(result.idea!.command);
    expect(html).toContain('falta confirmar su auditoría');
    expect(html).not.toContain('<textarea');
  });

  it('lists drafts separately from FeatureSpecs', async () => {
    const { IdeasList } = await import(listPath);
    const html = renderToStaticMarkup(createElement(IdeasList, { ideas: [result.idea] }));
    for (const text of [
      'Ideas pendientes · sin FeatureSpec',
      'Idea · pendiente',
      'data-state="idea_pending"',
      result.idea!.command,
    ])
      expect(html).toContain(text);
    expect(html).not.toMatch(/progressbar|feature-cost|<button|<textarea/);
  });
});
