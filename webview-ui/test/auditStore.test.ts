import { describe, expect, it } from 'vitest';

import type { AuditLogSnapshot, AuditViewEntry } from '../../core/src/messages.js';
import {
  applyAuditLog,
  auditNotices,
  auditValue,
  beginAuditRequest,
  emptyAuditStore,
  filterValues,
  formatAuditDate,
  getAuditStore,
  NO_VALUE,
  setAuditStore,
  subscribeAuditStore,
  viewState,
  visibleEntries,
} from '../src/office/auditStore.js';

const entry = (line: number, action: string, status: string): AuditViewEntry => ({
  line,
  occurredAt: '2026-10-16T10:00:05Z',
  actorType: 'operator',
  actorId: null,
  action,
  resourceType: 'task',
  resourceId: null,
  policyDecision: null,
  riskLevel: 'low',
  outcome: {
    status,
    reason: null,
    detail: null,
    tier: null,
    executor: null,
    model: null,
    code: null,
  },
  taskKey: null,
  executionId: null,
});
const snapshot = (over: Partial<AuditLogSnapshot> = {}): AuditLogSnapshot => ({
  type: 'auditLog',
  projectId: 'P',
  requestId: 'r1',
  status: 'ok',
  entries: [entry(3, 'B', 'success'), entry(2, 'A', 'failed'), entry(1, 'A', 'success')],
  totalValid: 3,
  truncated: false,
  corruptLines: [],
  excludedCount: 0,
  ...over,
});
const loaded = (over: Partial<AuditLogSnapshot> = {}) =>
  applyAuditLog(beginAuditRequest(emptyAuditStore(), 'P', 'r1'), snapshot(over));

describe('FEAT-001 audit store', () => {
  it('AC-004/005/006: filters with AND, preserves server order and distinguishes no matches', () => {
    const store = loaded();
    expect(visibleEntries(store).map((e) => e.line)).toEqual([3, 2, 1]);
    const action = { ...store, actionFilter: 'A' };
    expect(visibleEntries(action).map((e) => e.line)).toEqual([2, 1]);
    expect(visibleEntries({ ...action, outcomeFilter: 'success' }).map((e) => e.line)).toEqual([1]);
    const noMatches = { ...action, outcomeFilter: 'absent' };
    expect(viewState(noMatches)).toBe('no_matches');
    expect(viewState({ ...noMatches, actionFilter: null, outcomeFilter: null })).toBe('list');
    expect(store.snapshot?.entries).toEqual(snapshot().entries);
  });

  it('AC-021/022: options use loaded entries only; whole-file notices survive filtering', () => {
    const store = loaded({
      totalValid: 520,
      truncated: true,
      corruptLines: [1, 523],
      excludedCount: 2,
    });
    expect(filterValues(store.snapshot)).toEqual({
      actions: ['A', 'B'],
      outcomes: ['failed', 'success'],
    });
    const filtered = { ...store, actionFilter: 'missing', outcomeFilter: 'failed' };
    expect(filterValues(filtered.snapshot)).toEqual(filterValues(store.snapshot));
    expect(auditNotices(filtered)).toEqual({
      totalValid: 520,
      truncated: true,
      corruptLines: [1, 523],
      excludedCount: 2,
    });
    expect(filterValues(null)).toEqual({ actions: [], outcomes: [] });
  });

  it('AC-013: switches projects immediately and ignores stale project/request responses', () => {
    const old = {
      ...loaded({ corruptLines: [8], excludedCount: 1, truncated: true }),
      actionFilter: 'A',
      outcomeFilter: 'failed',
    };
    const next = beginAuditRequest(old, 'Q', 'r2');
    expect(next).toEqual({
      projectId: 'Q',
      requestId: 'r2',
      snapshot: null,
      loading: true,
      actionFilter: null,
      outcomeFilter: null,
    });
    expect(visibleEntries(next)).toEqual([]);
    expect(filterValues(next.snapshot)).toEqual({ actions: [], outcomes: [] });
    expect(auditNotices(next)).toEqual({
      totalValid: 0,
      truncated: false,
      corruptLines: [],
      excludedCount: 0,
    });
    expect(applyAuditLog(next, snapshot())).toBe(next);
    expect(applyAuditLog(next, snapshot({ projectId: 'Q' }))).toBe(next);
    expect(applyAuditLog(next, snapshot({ requestId: 'r2' }))).toBe(next);
    expect(viewState(applyAuditLog(next, snapshot({ projectId: 'Q', requestId: 'r2' })))).toBe(
      'list',
    );
    const refresh = beginAuditRequest(old, 'P', 'r3');
    expect(refresh.actionFilter).toBe('A');
    expect(applyAuditLog(refresh, snapshot())).toBe(refresh);
    expect(applyAuditLog(emptyAuditStore(), snapshot()).snapshot).toBeNull();
  });

  it('distinguishes loading, empty, denied, read errors and notice-only successful reads', () => {
    expect(viewState(emptyAuditStore())).toBe('empty');
    expect(viewState(beginAuditRequest(loaded(), 'P', 'r2'))).toBe('loading');
    for (const status of ['empty', 'denied', 'read_error'] as const)
      expect(viewState(loaded({ status, entries: [], totalValid: 0 }))).toBe(status);
    expect(viewState(loaded({ status: 'unknown_project', entries: [], totalValid: 0 }))).toBe(
      'denied',
    );
    for (const notices of [{ corruptLines: [1, 2] }, { excludedCount: 2 }])
      expect(viewState(loaded({ entries: [], totalValid: 0, ...notices }))).toBe('list');
  });

  it('AC-002/019: missing values have an explicit marker distinct from empty strings', () => {
    expect(NO_VALUE).toBe('sin valor');
    expect(auditValue(null)).toBe(NO_VALUE);
    expect(auditValue(undefined)).toBe(NO_VALUE);
    expect(auditValue('')).toBe('');
    expect(auditValue('redacted detail')).toBe('redacted detail');
  });

  it('AC-020: formats UTC+2 independently of locale and handles boundaries and invalid dates', () => {
    expect(formatAuditDate('2026-10-16T10:00:05Z', 120)).toEqual({
      local: '2026-10-16 12:00:05',
      utc: '2026-10-16 10:00:05 UTC',
    });
    expect(formatAuditDate('2026-12-31T23:45:09Z', 60)?.local).toBe('2027-01-01 00:45:09');
    expect(formatAuditDate('2026-01-01T00:00:05Z', -330)?.local).toBe('2025-12-31 18:30:05');
    for (const value of ['', 'invalid', 'not a date']) expect(formatAuditDate(value)).toBeNull();
    const iso = '2026-10-16T10:00:05Z';
    expect(formatAuditDate(iso)).toEqual(formatAuditDate(iso, -new Date(iso).getTimezoneOffset()));
  });

  it('publishes immutable store changes to subscribers and supports unsubscribe', () => {
    setAuditStore(emptyAuditStore());
    let calls = 0;
    const unsubscribe = subscribeAuditStore(() => calls++);
    const next = loaded();
    setAuditStore(next);
    expect(getAuditStore()).toBe(next);
    setAuditStore(next);
    expect(calls).toBe(1);
    unsubscribe();
    setAuditStore(emptyAuditStore());
    expect(calls).toBe(1);
  });
});
