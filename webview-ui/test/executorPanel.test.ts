import { describe, expect, it } from 'vitest';

import type { ExecutorAvailability, ExecutorState } from '../../core/src/messages.js';
import { EXECUTOR_STATUS_COLORS, EXECUTOR_TOGGLE_TIMEOUT_MS } from '../src/constants.js';
import { executorPanelView, executorStatus } from '../src/office/executorPanelView.js';
import {
  applyExecutorState,
  applyToggleResult,
  beginLevelToggle,
  beginToggle,
  emptyExecutorStore,
  type ExecutorStore,
  expirePending,
} from '../src/office/executorStore.js';
import { assignmentReason } from '../src/office/toolUtils.js';

const NOW_S = 1_000_000;
const row = (over: Partial<ExecutorAvailability> = {}): ExecutorAvailability => ({
  executorId: 'claude',
  enabled: true,
  eligible: true,
  reasonCodes: [],
  installation: 'ready',
  version: '2.1.296',
  authentication: 'ready',
  levels: ['standard', 'deep'],
  quotaGate: 'allow',
  activeExecutions: 1,
  concurrencyLimit: 1,
  checkedAt: NOW_S - 20,
  staleAfter: NOW_S + 100,
  ...over,
});
const state = (over: Partial<ExecutorState> = {}): ExecutorState => ({
  type: 'executorState',
  projectId: 'softwareagents',
  revision: 'r1',
  sequence: 0,
  observedAt: NOW_S,
  canManage: true,
  configurationStatus: 'ready',
  executors: [row(), row({ executorId: 'codex' })],
  ...over,
});
const withState = (s: ExecutorState): ExecutorStore => applyExecutorState(emptyExecutorStore(), s);

describe('executor status text', () => {
  it('never shows unknown, stale or unprobed as available', () => {
    expect(executorStatus(row(), NOW_S)).toEqual({
      text: 'Disponible',
      color: EXECUTOR_STATUS_COLORS.available,
    });
    for (const over of [
      { installation: 'unknown' as const },
      { checkedAt: null },
      { staleAfter: NOW_S - 1 },
    ])
      expect(executorStatus(row(over), NOW_S).text).toBe('Desconocido · comprobando');
  });

  it('picks the most important reason; off is the main status of a disabled executor', () => {
    expect(
      executorStatus(row({ reasonCodes: ['not_installed'], eligible: false }), NOW_S).text,
    ).toBe('No instalado');
    expect(
      executorStatus(
        row({ reasonCodes: ['auth_required', 'quota_blocked'], eligible: false }),
        NOW_S,
      ).text,
    ).toBe('Autenticación necesaria');
    expect(
      executorStatus(row({ reasonCodes: ['quota_blocked'], eligible: false }), NOW_S).text,
    ).toBe('Sin cuota');
    expect(
      executorStatus(
        row({ enabled: false, reasonCodes: ['operator_disabled', 'not_installed'] }),
        NOW_S,
      ),
    ).toEqual({ text: 'Desactivado', color: EXECUTOR_STATUS_COLORS.off });
  });
});

describe('executor panel view', () => {
  it('shows limits, levels and probe age; unknown limits are never infinite', () => {
    const view = executorPanelView(
      withState(state({ executors: [row({ concurrencyLimit: null, activeExecutions: null })] })),
      NOW_S * 1000,
    )!;
    expect(view.rows[0].details).toEqual([
      'standard, deep · ? ejecuciones / límite desconocido',
      'Cuota observada sana · v2.1.296 · comprobado hace 20 s',
    ]);
  });

  it('is read-only without privilege, with the reason said in words', () => {
    const view = executorPanelView(withState(state({ canManage: false })), NOW_S * 1000)!;
    expect(view.rows.every((r) => r.disabled)).toBe(true);
    expect(view.readOnlyNotice).toBe('Solo el operador puede cambiar la disponibilidad.');
    expect(view.rows[0].ariaLabel).toContain('Claude para nuevas tareas de softwareagents');
  });

  it('warns persistently when everything is off and when recovery is required', () => {
    const off = state({
      executors: [row({ enabled: false }), row({ executorId: 'codex', enabled: false })],
    });
    expect(executorPanelView(withState(off), NOW_S * 1000)!.banner).toMatch(
      /Nuevas tareas bloqueadas/,
    );
    const recovery = executorPanelView(
      withState(state({ configurationStatus: 'recovery_required' })),
      NOW_S * 1000,
    )!;
    expect(recovery.banner).toMatch(/executors recover/);
    expect(recovery.rows.every((r) => r.disabled)).toBe(true);
  });
});

describe('executor store: no optimistic update', () => {
  it('a toggle marks the row pending and leaves the switch as the server last said', () => {
    const started = beginToggle(withState(state()), 'codex', false, 0, 'req-1')!;
    expect(started.message).toEqual({
      type: 'setExecutorEnabled',
      projectId: 'softwareagents',
      executorId: 'codex',
      enabled: false,
      requestId: 'req-1',
      expectedRevision: 'r1',
    });
    const view = executorPanelView(started.store, NOW_S * 1000)!;
    const codex = view.rows[1];
    expect(codex).toMatchObject({
      checked: true,
      pending: true,
      disabled: true,
      status: 'Guardando…',
    });
    // A second click while pending sends nothing.
    expect(beginToggle(started.store, 'codex', false, 1, 'req-2')).toBeNull();
    // Without privilege nothing is ever sent.
    expect(beginToggle(withState(state({ canManage: false })), 'codex', false, 0, 'x')).toBeNull();
  });

  it('settles by requestId; a failure keeps the state, shows why and asks for a snapshot', () => {
    const started = beginToggle(withState(state()), 'codex', false, 0, 'req-1')!.store;
    const stray = applyToggleResult(started, {
      type: 'executorToggleResult',
      projectId: 'softwareagents',
      executorId: 'codex',
      requestId: 'other',
      status: 'applied',
    });
    expect(stray.store).toBe(started);
    const failed = applyToggleResult(started, {
      type: 'executorToggleResult',
      projectId: 'softwareagents',
      executorId: 'codex',
      requestId: 'req-1',
      status: 'rejected',
      errorCode: 'revision_conflict',
    });
    expect(failed.resync).toBe(true);
    expect(failed.store.pending.codex).toBeUndefined();
    expect(failed.store.state!.executors[1].enabled).toBe(true);
    expect(executorPanelView(failed.store, NOW_S * 1000)!.rows[1].error).toMatch(
      /cambió en otro sitio/,
    );
    const ok = applyToggleResult(beginToggle(failed.store, 'codex', false, 0, 'req-3')!.store, {
      type: 'executorToggleResult',
      projectId: 'softwareagents',
      executorId: 'codex',
      requestId: 'req-3',
      status: 'applied',
      revision: 'r2',
    });
    expect(ok.resync).toBe(false);
    expect(ok.store.errors.codex).toBeUndefined();
  });

  it('a lost answer expires, is reported and triggers a resync', () => {
    const started = beginToggle(withState(state()), 'claude', false, 1000, 'req-1')!.store;
    expect(expirePending(started, 1000 + EXECUTOR_TOGGLE_TIMEOUT_MS - 1).resync).toBe(false);
    const expired = expirePending(started, 1000 + EXECUTOR_TOGGLE_TIMEOUT_MS);
    expect(expired.resync).toBe(true);
    expect(expired.store.pending.claude).toBeUndefined();
    expect(expired.store.errors.claude).toMatch(/Sin respuesta/);
  });

  it('ignores out-of-order snapshots but accepts a reconnect (sequence restarts at 0)', () => {
    const s5 = withState(state({ sequence: 5, revision: 'r5' }));
    expect(applyExecutorState(s5, state({ sequence: 4, revision: 'r4' }))).toBe(s5);
    expect(applyExecutorState(s5, state({ sequence: 6, revision: 'r6' })).state!.revision).toBe(
      'r6',
    );
    expect(applyExecutorState(s5, state({ sequence: 0, revision: 'r0' })).state!.revision).toBe(
      'r0',
    );
  });
});

describe('SA-092 level controls', () => {
  const tiered = () =>
    withState(
      state({
        executors: [
          row({ levels: ['deep'], catalogLevels: ['standard', 'deep'] }),
          row({ executorId: 'codex', levels: [], catalogLevels: ['economy'] }),
        ],
      }),
    );

  it('sends the complete allowed set from the confirmed levels, in catalog order', () => {
    const started = beginLevelToggle(tiered(), 'claude', 'standard', true, 0, 'lvl-1')!;
    expect(started.message).toEqual({
      type: 'setExecutorLevels',
      projectId: 'softwareagents',
      executorId: 'claude',
      levels: ['standard', 'deep'],
      requestId: 'lvl-1',
      expectedRevision: 'r1',
    });
    // No optimism: the checkbox keeps what the server said while the row is pending.
    const claude = executorPanelView(started.store, NOW_S * 1000)!.rows[0];
    expect(claude.pending).toBe(true);
    expect(claude.levelControls!.map((l) => l.allowed)).toEqual([false, true]);
    expect(beginLevelToggle(started.store, 'claude', 'deep', false, 1, 'lvl-2')).toBeNull();
    // Disallowing the last level is allowed: an empty list blocks the Executor.
    expect(beginLevelToggle(tiered(), 'claude', 'deep', false, 0, 'x')!.message).toMatchObject({
      levels: [],
    });
    // Never a level the catalog does not offer.
    expect(beginLevelToggle(tiered(), 'codex', 'deep', true, 0, 'x')).toBeNull();
  });

  it('shows editable levels only to a manager of a server that offers them', () => {
    const view = executorPanelView(tiered(), NOW_S * 1000)!;
    expect(view.rows[0].levelControls).toEqual([
      expect.objectContaining({ tier: 'standard', allowed: false }),
      expect.objectContaining({ tier: 'deep', allowed: true }),
    ]);
    expect(view.rows[0].levelControls![0].ariaLabel).toBe(
      'Nivel standard de Claude en softwareagents: no permitido',
    );
    expect(view.rows[0].details[0]).toMatch(/^deep \(no permitido: standard\) · /);
    expect(view.rows[1].details[0]).toMatch(/^ningún nivel permitido \(no permitido: economy\)/);
    const viewer = withState({ ...tiered().state!, canManage: false });
    expect(executorPanelView(viewer, NOW_S * 1000)!.rows[0].levelControls).toBeNull();
    expect(beginLevelToggle(viewer, 'claude', 'standard', true, 0, 'x')).toBeNull();
    // A server without SA-092 sends no catalogLevels: no controls.
    expect(executorPanelView(withState(state()), NOW_S * 1000)!.rows[0].levelControls).toBeNull();
  });

  it('a rejected level change keeps the levels and resyncs, like a toggle', () => {
    const started = beginLevelToggle(tiered(), 'claude', 'standard', true, 0, 'lvl-1')!.store;
    const failed = applyToggleResult(started, {
      type: 'executorToggleResult',
      projectId: 'softwareagents',
      executorId: 'claude',
      requestId: 'lvl-1',
      status: 'rejected',
      errorCode: 'invalid_request',
    });
    expect(failed.resync).toBe(true);
    expect(failed.store.state!.executors[0].levels).toEqual(['deep']);
    expect(executorPanelView(failed.store, NOW_S * 1000)!.rows[0].error).toMatch(/catálogo/);
  });
});

describe('assignment reason in the overlay', () => {
  it('shows only the recorded decision; unmanaged sessions are said to be unmanaged', () => {
    expect(
      assignmentReason(
        { label: 'DEV', department: 'Ingeniería', selectionReason: 'standard: cuota admitida' },
        true,
      ),
    ).toBe('standard: cuota admitida');
    expect(
      assignmentReason({ label: 'DEV', department: 'Ingeniería', tier: 'standard' }, true),
    ).toBeUndefined();
    expect(assignmentReason(undefined, true)).toBe('Sesión externa · asignación no gestionada');
    expect(assignmentReason(undefined, false)).toBeUndefined();
  });
});
