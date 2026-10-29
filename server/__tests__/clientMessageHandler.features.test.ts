import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeatureRow } from '../../core/src/messages.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import * as auditLog from '../src/auditLog.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import * as featuresView from '../src/featuresView.js';

vi.mock('../src/companyControl.js', () => ({ companyWorkspaceRoot: () => 'bound-root' }));
vi.mock('../src/projectConfig.js', () => ({
  loadProjectConfig: () => ({ project: { id: 'selected' }, operator: {} }),
}));
vi.mock('../src/configPersistence.js', () => ({
  readConfig: () => ({ projects: {} }),
  projectConfigError: () => undefined,
}));

describe('requestFeatures (AC-006, AC-010, AC-011, AC-012)', () => {
  let store: AgentStateStore;
  const send = vi.fn();
  const request = { type: 'requestFeatures', projectId: 'selected', requestId: 'r1' };

  beforeEach(() => {
    store = new AgentStateStore();
    send.mockClear();
    vi.spyOn(featuresView, 'readFeaturesView').mockResolvedValue({
      status: 'empty',
      reason: null,
      features: [],
    });
    vi.spyOn(auditLog, 'recordAudit').mockImplementation(() => undefined);
  });

  afterEach(() => {
    expect(auditLog.recordAudit).not.toHaveBeenCalled();
    store.dispose();
    vi.restoreAllMocks();
  });

  function dispatch(fields = {}, privileged: boolean | undefined = true) {
    handleClientMessage({ ...request, ...fields }, send, { store, cache: null, privileged });
  }

  it.each([{ projectId: null }, { projectId: 1 }, { requestId: null }, { requestId: {} }])(
    'ignores malformed identifiers: %j',
    (fields) => {
      dispatch(fields);
      expect(send).not.toHaveBeenCalled();
      expect(featuresView.readFeaturesView).not.toHaveBeenCalled();
    },
  );

  it.each([false, undefined])('denies privilege %s before project lookup (AC-012)', (privilege) => {
    handleClientMessage(request, send, { store, cache: null, privileged: privilege });
    expect(send).toHaveBeenCalledExactlyOnceWith({
      ...request,
      type: 'featuresSnapshot',
      status: 'denied',
      reason: null,
      features: [],
    });
    expect(featuresView.readFeaturesView).not.toHaveBeenCalled();
  });

  it.each(['other', 'nonexistent'])('rejects unselected Project %s (AC-011)', (projectId) => {
    dispatch({ projectId });
    expect(send).toHaveBeenCalledExactlyOnceWith({
      ...request,
      projectId,
      type: 'featuresSnapshot',
      status: 'unknown_project',
      reason: null,
      features: [],
    });
    expect(featuresView.readFeaturesView).not.toHaveBeenCalled();
  });

  it('reads only the bound root and Project and returns correlated rows (AC-006, AC-011)', async () => {
    const row: FeatureRow = {
      key: 'FEAT-010',
      title: 'Feature',
      state: 'in_review',
      rawStatus: null,
      progress: null,
      currentTask: null,
      gates: [],
      integration: null,
      lastActivityAt: null,
      cost: {
        executions: 1,
        costKnown: 1,
        costUsd: 1,
        costPerDoneTaskUsd: null,
        cacheHitRate: null,
      },
    };
    vi.mocked(featuresView.readFeaturesView).mockResolvedValue({
      status: 'ok',
      reason: null,
      features: [row],
    });
    dispatch();
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledExactlyOnceWith({
        ...request,
        type: 'featuresSnapshot',
        status: 'ok',
        reason: null,
        features: [row],
      }),
    );
    expect(featuresView.readFeaturesView).toHaveBeenCalledExactlyOnceWith('bound-root', 'selected');
  });

  it.each(['empty', 'read_error'] as const)('preserves reader %s (AC-010)', async (status) => {
    const result = {
      status,
      reason: status === 'read_error' ? ('unavailable' as const) : null,
      features: [],
    };
    vi.mocked(featuresView.readFeaturesView).mockResolvedValue(result);
    dispatch();
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledExactlyOnceWith({
        ...request,
        type: 'featuresSnapshot',
        ...result,
      }),
    );
  });

  it('sanitizes rejected reads without retaining rows (AC-010)', async () => {
    vi.mocked(featuresView.readFeaturesView).mockRejectedValue(new Error('private path and trace'));
    dispatch();
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledExactlyOnceWith({
        ...request,
        type: 'featuresSnapshot',
        status: 'read_error',
        reason: 'query_failed',
        features: [],
      }),
    );
  });
});
