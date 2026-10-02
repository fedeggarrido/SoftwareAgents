import { describe, expect, it } from 'vitest';

import type { ProviderQuota } from '../../core/src/messages.js';
import { QUOTA_COLORS } from '../src/constants.js';
import { capacityView } from '../src/office/capacityView.js';

describe('capacity view', () => {
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
    const view = capacityView(quota, 2);
    expect(view.status).toBe('Sana');
    expect(view.detail).toBe('Menos del 90 % usado');
    expect(view.provenance).toBe(
      '2 agentes en marcha · Fuente: claude_stream_json · Confianza: low',
    );
    expect(view.windows).toEqual([
      '5 horas: uso desconocido · Reset: ' +
        new Date(200 * 1000).toLocaleString('es-ES', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }),
    ]);
  });
  it.each([
    ['warning', 'Limitada', QUOTA_COLORS.warning],
    ['rejected', 'Agotada', QUOTA_COLORS.rejected],
    ['unknown', 'Desconocida', QUOTA_COLORS.unknown],
    ['reset', 'Desconocida', QUOTA_COLORS.unknown],
  ] as const)('labels %s capacity as %s', (status, label, color) => {
    expect(capacityView({ ...quota, status }, 0)).toMatchObject({ status: label, color });
  });
  it('keeps older boards readable with explicit unknown confidence', () => {
    const view = capacityView({ ...quota, capacity: undefined, status: 'unknown' }, 0);
    expect(view.provenance).toBe('0 agentes en marcha · Fuente: estimated · Confianza: unknown');
    expect(view.windows).toEqual([]);
    expect(view.detail).toBe('Aún no hay una lectura de cuota');
  });
  it('distinguishes renewed quota from missing observations', () => {
    expect(capacityView({ ...quota, status: 'reset' }, 0).detail).toBe(
      'La cuota se renovó; falta una nueva lectura',
    );
  });
  it('shows measured windows, unknown resets and other window kinds', () => {
    const capacity = {
      ...quota.capacity!,
      windows: [
        { kind: 'five_hour' as const, usedRatio: 0, resetsAt: null },
        { kind: 'weekly' as const, usedRatio: 0.956, resetsAt: null },
        { kind: 'other' as const, usedRatio: null, resetsAt: null },
      ],
    };
    expect(capacityView({ ...quota, capacity }, 0).windows).toEqual([
      '5 horas: 0 % usado · Reset: —',
      'Semanal: 96 % usado · Reset: —',
      'Otra ventana: uso desconocido · Reset: —',
    ]);
  });
  it('uses the weekly reset when the weekly limit is exhausted', () => {
    const view = capacityView(
      { ...quota, status: 'rejected', resetsAt: 100, weekly: { usedPercent: 100, resetsAt: 200 } },
      0,
    );
    expect(view.detail).toBe(
      'Límite semanal alcanzado · se renueva a las ' +
        new Date(200 * 1000).toLocaleTimeString('es-ES', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
    );
  });
  it('preserves warning and healthy usage details', () => {
    expect(capacityView({ ...quota, status: 'warning' }, 0).detail).toBe('Al menos 90 % usado');
    expect(
      capacityView({ ...quota, usedPercent: 42, weekly: { usedPercent: 60, resetsAt: null } }, 0)
        .detail,
    ).toBe('42 % usado · 60 % esta semana');
  });
});
