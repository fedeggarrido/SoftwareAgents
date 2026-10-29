import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeatureRow, FeaturesSnapshot } from '../../core/src/messages.js';
import { emptyExecutorStore, setExecutorStore } from '../src/office/executorStore.js';
import {
  applyFeaturesSnapshot,
  beginFeaturesRequest,
  emptyFeaturesStore,
  getFeaturesStore,
  setFeaturesStore,
} from '../src/office/featuresStore.js';

const lifecycle = vi.hoisted(() => ({
  effects: [] as Array<() => void>,
  state: 'connected',
  send: vi.fn(),
}));
vi.mock('../src/transport/index.js', () => ({
  transport: {
    send: lifecycle.send,
    get state() {
      return lifecycle.state;
    },
    onStateChange: () => () => {},
  },
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_: unknown, get: () => unknown) => get(),
  useEffect: (effect: () => void) => {
    lifecycle.effects.push(effect);
  },
}));
const panelPath = '../src/components/FeaturesPanel.js';
const close = vi.fn();
async function tree(isOpen = true): Promise<ReactElement> {
  const { FeaturesPanel } = await import(panelPath);
  return FeaturesPanel({ isOpen, onClose: close });
}
const render = async () => renderToStaticMarkup(await tree());
async function flush(isOpen = true) {
  lifecycle.effects = [];
  await tree(isOpen);
  for (const effect of lifecycle.effects) effect();
}
const project = (projectId: string) =>
  setExecutorStore({
    ...emptyExecutorStore(),
    state: { projectId } as NonNullable<ReturnType<typeof emptyExecutorStore>['state']>,
  });
const row: FeatureRow = {
  key: 'FEAT-020',
  title: '<b>Title</b>',
  state: 'in_development',
  rawStatus: null,
  progress: { done: 2, total: 5 },
  currentTask: { key: 'FEAT-020-T02', step: 'review', others: 2 },
  gates: [
    {
      kind: 'human_decision',
      task: 'FEAT-020-T02',
      expired: true,
      command: 'pixel-agents feature show FEAT-020',
    },
  ],
  integration: { branch: 'sa/FEAT-020-integration', sha: 'abcdef0' },
  lastActivityAt: null,
  cost: { executions: 3, costKnown: 3, costUsd: 0.6, costPerDoneTaskUsd: 0.3, cacheHitRate: 0.5 },
};
function respond(over: Partial<FeaturesSnapshot> = {}) {
  const store = getFeaturesStore();
  setFeaturesStore(
    applyFeaturesSnapshot(store, {
      type: 'featuresSnapshot',
      projectId: store.projectId!,
      requestId: store.requestId!,
      status: 'ok',
      reason: null,
      features: [row],
      ...over,
    }),
  );
}
beforeEach(() => {
  lifecycle.effects = [];
  lifecycle.state = 'connected';
  lifecycle.send.mockClear();
  close.mockClear();
  project('P');
  setFeaturesStore(beginFeaturesRequest(emptyFeaturesStore(), 'P', 'r'));
  respond();
});
describe('FEAT-002-T06 panel acceptance', () => {
  it.each([
    { executions: 4, costKnown: 0, costUsd: null, costPerDoneTaskUsd: null, cacheHitRate: null },
    { executions: 1, costKnown: 1, costUsd: 0, costPerDoneTaskUsd: 0, cacheHitRate: null },
  ])('FEAT-003 AC-003 distinguishes historical unknown from known zero: %j', async (cost) => {
    respond({ features: [{ ...row, cost }] });
    const html = await render();
    expect(html).toContain(`Ejecuciones: ${cost.executions}`);
    expect(html).toContain(`Cobertura: ${cost.costKnown} de ${cost.executions}`);
    expect(html).toContain(`Coste: ${cost.costUsd === null ? 'sin datos' : '0.00 USD'}`);
    expect(html).toContain(
      `Coste/tarea DONE: ${cost.costPerDoneTaskUsd === null ? 'sin datos' : '0.00 USD'}`,
    );
    expect(html.match(/sin datos/g)).toHaveLength(cost.costUsd === null ? 3 : 1);
    expect(html).not.toMatch(/NaN|Infinity|\(parcial\)/);
    if (cost.costUsd === null) expect(html).not.toContain('0.00 USD');
  });

  it('FEAT-003 AC-005 hides costs across Projects with the same feature key', async () => {
    const previousRequest = getFeaturesStore().requestId!;
    expect(await render()).toContain('Coste: 0.60 USD');
    project('Q');
    expect(await render()).not.toContain('USD');
    await flush();
    respond({ features: [{ ...row, cost: { ...row.cost, costUsd: 5 } }] });
    expect(await render()).toContain('Coste: 5.00 USD');
    respond({ projectId: 'P', requestId: previousRequest });
    const html = await render();
    expect(html).toContain('Coste: 5.00 USD');
    expect(html).not.toContain('Coste: 0.60 USD');
    expect(lifecycle.send).toHaveBeenCalledTimes(1);
    expect(lifecycle.send).toHaveBeenCalledWith({
      type: 'requestFeatures',
      projectId: 'Q',
      requestId: getFeaturesStore().requestId,
    });
  });

  it('FEAT-003 AC-001/002/003/004/007/008 renders only cost text with explicit partial coverage', async () => {
    const sensitive = {
      prompt: 'PRIVATE_PROMPT',
      output: 'PRIVATE_OUTPUT',
      path: 'C:\\private\\ledger',
      prices: 'PRIVATE_PRICES',
    };
    respond({
      features: [
        { ...row, ...sensitive, cost: { ...row.cost, ...sensitive, executions: 5, costUsd: 0.9 } },
      ],
    });
    const html = await render();
    const block = html.match(/<div class="feature-cost[^>]*>(.*?)<\/div>/s)?.[1];
    expect(block).toBeDefined();
    for (const text of [
      'Coste: 0.90 USD (parcial)',
      'Ejecuciones: 5',
      'Cobertura: 3 de 5',
      'Coste/tarea DONE: 0.30 USD',
      'Caché: 50 %',
    ])
      expect(block).toContain(text);
    expect(block).not.toMatch(/<(button|input|select|textarea|a)\b/);
    for (const text of Object.values(sensitive)) expect(html).not.toContain(text);
    respond({
      features: [
        {
          ...row,
          cost: {
            ...row.cost,
            executions: 0,
            costKnown: 0,
            costUsd: null,
            costPerDoneTaskUsd: null,
            cacheHitRate: null,
          },
        },
      ],
    });
    const empty = await render();
    expect(empty).toContain('Cobertura: 0 de 0');
    expect(empty.match(/sin datos/g)).toHaveLength(3);
    expect(empty).not.toContain('0.00 USD');
    respond({
      features: [{ ...row, cost: { ...row.cost, costUsd: 0.5, costPerDoneTaskUsd: null } }],
    });
    expect(await render()).toContain('Coste/tarea DONE: sin datos');
    respond({ status: 'denied' });
    expect(await render()).not.toContain('feature-cost');
    expect(await render()).not.toContain('USD');
  });
  it('AC-001/002/003/005/007/008/013 renders ordered rows and escaped text', async () => {
    respond({
      features: [
        row,
        {
          ...row,
          key: 'FEAT-021',
          title: null,
          progress: null,
          currentTask: null,
          gates: [],
          integration: null,
        },
      ],
    });
    const html = await render();
    for (const text of [
      '&lt;b&gt;Title&lt;/b&gt;',
      'en desarrollo',
      '2/5',
      'review',
      '+2',
      'human_decision',
      'expirado',
      '<code>pixel-agents feature show FEAT-020</code>',
      'sa/FEAT-020-integration',
      'abcdef0',
      'sin tareas',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('<b>Title</b>');
    expect(html.indexOf('FEAT-020')).toBeLessThan(html.indexOf('FEAT-021'));
    expect(html.match(/<article/g)).toHaveLength(2);
    expect(html).toContain('feature-row');
    expect(html).toContain('feature-state-chip');
    expect(html).toContain('data-state="in_development"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="2"');
    expect(html).toContain('aria-valuemax="5"');
    expect(html).toContain('width:40%');
    expect(html).not.toContain('<dl>');
  });
  it('renders the merged chip and a complete progress bar', async () => {
    respond({ features: [{ ...row, state: 'merged', progress: { done: 5, total: 5 } }] });
    const html = await render();
    expect(html).toContain('data-state="merged"');
    expect(html).toContain('fusionada');
    expect(html).toContain('width:100%');
  });
  it.each([
    ['empty', 'sin features'],
    ['read_error', 'Error de lectura'],
    ['denied', 'Acceso denegado'],
  ] as const)('AC-009/010 distinguishes %s without rows', async (status, text) => {
    respond({ status, reason: 'unavailable' });
    const html = await render();
    expect(html).toContain(text);
    expect(html).not.toContain('<article');
    if (status !== 'empty') expect(html).not.toContain('sin features');
  });
  it('AC-006/014 only refresh and close controls; refresh requests new data', async () => {
    // Inspect actual React button props to exercise the callbacks without a DOM.
    function buttons(node: unknown): Array<{ children: unknown; onClick: () => void }> {
      if (!node || typeof node !== 'object') return [];
      if (Array.isArray(node)) return node.flatMap(buttons);
      const props = (node as ReactElement<{ children?: unknown; onClick?: () => void }>).props;
      if (!props) return [];
      return [
        ...(props.onClick ? [props as { children: unknown; onClick: () => void }] : []),
        ...buttons(props.children),
      ];
    }
    const controls = buttons(await tree());
    expect(controls.map((button) => button.children)).toEqual(['Cerrar', 'Actualizar']);
    controls[1].onClick();
    expect(lifecycle.send).toHaveBeenCalledTimes(1);
    await flush();
    expect(lifecycle.send).toHaveBeenCalledTimes(1);
    expect(getFeaturesStore().requestId).not.toBe('r');
    expect(await render()).toContain('Cargando');
    respond({
      features: [
        {
          ...row,
          progress: { done: 3, total: 5 },
          currentTask: { key: 'FEAT-020-T03', step: 'develop', others: 0 },
        },
      ],
    });
    const html = await render();
    expect(html).toContain('3/5');
    expect(html).toContain('FEAT-020-T03');
    expect(html).not.toContain('review');
    controls[0].onClick();
    expect(close).toHaveBeenCalledOnce();
    expect(lifecycle.send.mock.calls.every(([message]) => message.type === 'requestFeatures')).toBe(
      true,
    );
  });
  it('AC-011 requests on open/reconnect and hides previous Project before effects', async () => {
    setFeaturesStore(emptyFeaturesStore());
    await flush();
    const first = getFeaturesStore().requestId!;
    expect(lifecycle.send).toHaveBeenCalledTimes(1);
    await flush();
    expect(lifecycle.send).toHaveBeenCalledTimes(1);
    respond();
    project('Q');
    expect(await render()).not.toContain('FEAT-020');
    await flush();
    respond({ projectId: 'P', requestId: first });
    expect(getFeaturesStore().snapshot).toBeNull();
    lifecycle.state = 'reconnecting';
    await flush();
    lifecycle.state = 'connected';
    await flush();
    expect(lifecycle.send).toHaveBeenCalledTimes(3);
    await flush(false);
    expect(getFeaturesStore()).toEqual(emptyFeaturesStore());
    await flush();
    expect(lifecycle.send).toHaveBeenCalledTimes(4);
  });
});
