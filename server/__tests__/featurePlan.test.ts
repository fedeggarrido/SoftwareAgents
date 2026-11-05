import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { FEATURE_PLAN_HEADINGS } from '../src/constants.js';
import { featureDocument } from '../src/featureArtifacts.js';
import { designSection, handleFeaturePlanMessage, projectFeaturePlan } from '../src/featurePlan.js';
import { loadProjectConfig } from '../src/projectConfig.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import type { FeatureRecord } from '../src/workstore/WorkStore.js';

vi.mock('../src/companyControl.js', () => ({ companyWorkspaceRoot: vi.fn() }));
vi.mock('../src/projectConfig.js', () => ({ loadProjectConfig: vi.fn() }));
vi.mock('../src/workstore/SqliteWorkStore.js', () => ({ openWorkStore: vi.fn() }));
vi.mock('../src/featureArtifacts.js', () => ({ featureDocument: vi.fn() }));

const approval = {
  type: 'approveFeaturePlan',
  projectId: 'selected',
  requestId: 'r',
  key: 'FEAT-001',
  revision: 'a'.repeat(64),
};
const send = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  for (const marker of ['SA_MANAGED_EXECUTION', 'SA_WORKER', 'SA_AUTOPILOT', 'CLAUDECODE'])
    vi.stubEnv(marker, undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('SA-111 plan boundary', () => {
  it('binds the revision to all displayed sources and preserves it after approval', () => {
    const feature: FeatureRecord = {
      project_id: 'selected',
      key: 'FEAT-001',
      doc_path: 'spec.yaml',
      git_sha: 'a'.repeat(40),
      status: 'in_review',
    };
    const store = { getFeature: () => feature, getTask: vi.fn(), getDesign: vi.fn() };
    const config = {} as NonNullable<ReturnType<typeof loadProjectConfig>>;
    const document = {
      spec: { title: 'Título' },
      branch: 'fixture',
      sources: { requirements: 'Requisito', design: '## Seguridad\nDato literal', dag: 'Tareas' },
    } as ReturnType<typeof featureDocument>;
    vi.mocked(featureDocument).mockReturnValue(document);
    const plan = projectFeaturePlan(store, config, feature.key);
    expect(plan.sections.find((section) => section.id === 'security')?.content).toBe(
      '## Seguridad\nDato literal',
    );
    expect(plan.sections.find((section) => section.id === 'ci')?.content).toBeNull();
    feature.status = 'approved';
    expect(projectFeaturePlan(store, config, feature.key)).toMatchObject({
      revision: plan.revision,
      approved: true,
    });
    for (const field of ['requirements', 'design', 'dag'] as const) {
      vi.mocked(featureDocument).mockReturnValue({
        ...document,
        sources: { ...document.sources, [field]: 'Cambio' },
      });
      expect(projectFeaturePlan(store, config, feature.key).revision).not.toBe(plan.revision);
    }
  });
  it.each([false, undefined])(
    'refuses read-only privilege %s at the normal message entry before Project lookup',
    (privileged) => {
      const store = new AgentStateStore();
      try {
        handleClientMessage({ ...approval, actor: 'human', privileged: true }, send, {
          store,
          cache: null,
          privileged,
        });
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'featureApprovalResult',
            errorCode: 'denied',
            status: 'rejected',
          }),
        );
        expect(loadProjectConfig).not.toHaveBeenCalled();
        expect(openWorkStore).not.toHaveBeenCalled();
      } finally {
        store.dispose();
      }
    },
  );
  it.each(['human', 'agent', 'system'])(
    'rejects a forged actor %s even on a privileged connection',
    async (actor) => {
      await handleFeaturePlanMessage({ ...approval, actor }, send, true);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'invalid_request' }));
      expect(openWorkStore).not.toHaveBeenCalled();
      expect(loadProjectConfig).not.toHaveBeenCalled();
    },
  );
  it.each(['SA_MANAGED_EXECUTION', 'SA_WORKER', 'SA_AUTOPILOT', 'CLAUDECODE'])(
    'fails closed with server marker %s, including an empty value',
    async (marker) => {
      vi.stubEnv(marker, '');
      await handleFeaturePlanMessage(approval, send, true);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'denied' }));
      expect(openWorkStore).not.toHaveBeenCalled();
    },
  );
  it('refuses the VS Code adapter before any Project access', async () => {
    await handleFeaturePlanMessage(approval, send, true, false);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'unsupported_adapter' }),
    );
    expect(loadProjectConfig).not.toHaveBeenCalled();
    expect(openWorkStore).not.toHaveBeenCalled();
  });
  it('marks absent sections explicitly and never infers a security plan from arbitrary mentions', () => {
    expect(designSection(null, FEATURE_PLAN_HEADINGS.security)).toBeNull();
    expect(
      designSection('# Architecture\nSecurity will be considered.', FEATURE_PLAN_HEADINGS.security),
    ).toBeNull();
    expect(
      designSection('```md\n## Seguridad\nInvented\n```', FEATURE_PLAN_HEADINGS.security),
    ).toBeNull();
    expect(
      designSection(
        '## Seguridad\nTexto literal\n### Riesgos\nRiesgo\n## Otra\nNo incluir',
        FEATURE_PLAN_HEADINGS.security,
      ),
    ).toBe('## Seguridad\nTexto literal\n### Riesgos\nRiesgo');
  });
});
