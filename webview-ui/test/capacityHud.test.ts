import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderQuota } from '../../core/src/messages.js';
import { QuotaRow } from '../src/components/CompanyHud.js';
vi.mock('../src/transport/index.js', () => ({ transport: { send: vi.fn() } }));
describe('capacity HUD', () => {
  const quota: ProviderQuota = {
    provider: 'claude',
    status: 'allowed',
    usedPercent: null,
    resetsAt: null,
    observedAt: 100,
    capacity: {
      provider: 'claude',
      status: 'allowed',
      source: 'claude_stream_json',
      confidence: 'low',
      observedAt: 100,
      windows: [{ kind: 'five_hour', usedRatio: null, resetsAt: 200 }],
    },
  };
  it('shows provenance, confidence, running sessions and unmeasured windows', () => {
    const html = renderToStaticMarkup(
      createElement(QuotaRow, { name: 'Claude', q: quota, running: 2 }),
    );
    for (const text of [
      'Sana',
      'claude_stream_json',
      'low',
      '2',
      'agentes en marcha',
      '5 horas',
      'uso desconocido',
      'Reset:',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('5 horas: 0 % usado');
  });
  it.each([
    ['warning', 'Limitada'],
    ['rejected', 'Agotada'],
    ['unknown', 'Desconocida'],
    ['reset', 'Desconocida'],
  ] as const)('labels %s capacity as %s', (status, label) => {
    expect(
      renderToStaticMarkup(
        createElement(QuotaRow, { name: 'Claude', q: { ...quota, status }, running: 0 }),
      ),
    ).toContain(label);
  });
  it('keeps older boards readable with explicit unknown confidence', () => {
    expect(
      renderToStaticMarkup(
        createElement(QuotaRow, {
          name: 'Claude',
          q: { ...quota, capacity: undefined, status: 'unknown' },
          running: 0,
        }),
      ),
    ).toContain('unknown');
  });
});
