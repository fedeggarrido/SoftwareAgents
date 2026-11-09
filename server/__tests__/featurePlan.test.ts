import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import type { FeatureSpec } from '../../core/src/featureSpec.js';
import type { TaskDag } from '../../core/src/taskDag.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { FEATURE_PLAN_HEADINGS } from '../src/constants.js';
import { featureDocument } from '../src/featureArtifacts.js';
import { designSection, handleFeaturePlanMessage, projectFeaturePlan } from '../src/featurePlan.js';
import { loadProjectConfig } from '../src/projectConfig.js';
import { readMainAncestors } from '../src/workstore/readOnlyWorkStore.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import type { FeatureRecord } from '../src/workstore/WorkStore.js';

vi.mock('../src/companyControl.js', () => ({ companyWorkspaceRoot: vi.fn() }));
vi.mock('../src/projectConfig.js', () => ({ loadProjectConfig: vi.fn() }));
vi.mock('../src/workstore/SqliteWorkStore.js', () => ({ openWorkStore: vi.fn() }));
vi.mock('../src/featureArtifacts.js', () => ({ featureDocument: vi.fn() }));
vi.mock('../src/workstore/readOnlyWorkStore.js', () => ({
  readMainAncestors: vi.fn(),
  openReadOnlyWorkStore: vi.fn(),
}));

const spec: FeatureSpec = {
  apiVersion: 'softwareagents.io/v1alpha1',
  kind: 'FeatureSpec',
  key: 'FEAT-001',
  version: '1.0.0',
  status: 'draft',
  title: 'Plan legible',
  goal: 'Revisar el trabajo',
  userValue: 'Entender la decisión',
  actors: ['Operador'],
  flows: ['Abrir el plan'],
  rules: ['No cambiar permisos', 'Mostrar los títulos'],
  edgeCases: ['Plan sin pruebas'],
  acceptance: [
    {
      id: 'AC-001',
      given: 'un plan',
      when: 'se abre',
      then: 'se lee',
      ears: 'The system shall show the plan.',
    },
  ],
  openQuestions: [],
  links: { adr: [], clickup: [] },
};
const dag: TaskDag = {
  apiVersion: spec.apiVersion,
  kind: 'TaskDAG',
  feature: spec.key,
  tasks: [
    {
      key: 'FEAT-001-T01',
      type: 'code',
      title: 'Crear resumen',
      description: 'Proyectar campos',
      acceptanceRefs: ['AC-001'],
      dependsOn: [],
      agentRole: 'developer',
      size: 'M',
    },
    {
      key: 'FEAT-001-T02',
      type: 'code',
      title: 'Mostrar resumen',
      description: 'Renderizar texto',
      acceptanceRefs: ['AC-001'],
      dependsOn: ['FEAT-001-T01'],
      agentRole: 'developer',
      size: 'S',
    },
  ],
};
function fixtureDocument(): ReturnType<typeof featureDocument> {
  return {
    spec,
    branch: 'fixture',
    sources: {
      requirements: stringify(spec),
      design: `---\n${stringify({ apiVersion: spec.apiVersion, kind: 'TechnicalDesign', feature: spec.key, version: '1.0.0', status: 'proposed', components: ['Vista del plan'], risks: ['Datos incompletos'], adrs: [] })}---\n## Seguridad\nDato literal\n`,
      dag: stringify(dag),
    },
  };
}

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
    const store = {
      getFeature: () => feature,
      getTask: vi.fn(),
      getDesign: vi.fn(),
      getFeatureRun: vi.fn(),
    };
    const config = {} as NonNullable<ReturnType<typeof loadProjectConfig>>;
    const document = fixtureDocument();
    vi.mocked(featureDocument).mockReturnValue(document);
    const plan = projectFeaturePlan(store, config, feature.key);
    expect(plan.sections.find((section) => section.id === 'security')?.content).toBe(
      '## Seguridad\nDato literal',
    );
    expect(plan.sections.find((section) => section.id === 'ci')?.content).toBeNull();
    feature.status = 'approved';
    expect(projectFeaturePlan(store, config, feature.key)).toMatchObject({
      specApproved: true,
      approved: false,
    });
    feature.approved_plan_revision = null;
    expect(projectFeaturePlan(store, config, feature.key)).toMatchObject({
      specApproved: true,
      approved: false,
    });
    feature.approved_plan_revision = plan.revision;
    expect(projectFeaturePlan(store, config, feature.key)).toMatchObject({
      revision: plan.revision,
      approved: true,
    });
    for (const field of ['requirements', 'design', 'dag'] as const) {
      vi.mocked(featureDocument).mockReturnValue({
        ...document,
        sources: { ...document.sources, [field]: `${document.sources[field]}\n# Cambio\n` },
      });
      const changed = projectFeaturePlan(store, config, feature.key);
      expect(changed.revision).not.toBe(plan.revision);
      expect(changed).toMatchObject({ specApproved: true, approved: false });
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
  it.each([false, undefined])(
    'denies plan reads with privilege %s before Project lookup',
    (privileged) => {
      const store = new AgentStateStore();
      try {
        handleClientMessage(
          { type: 'requestFeaturePlan', projectId: 'selected', requestId: 'r', key: 'FEAT-001' },
          send,
          { store, cache: null, privileged },
        );
        expect(send).toHaveBeenCalledExactlyOnceWith({
          type: 'featurePlanSnapshot',
          projectId: 'selected',
          requestId: 'r',
          key: 'FEAT-001',
          plan: null,
          canApprove: false,
          approvalBlock: 'read_only',
          errorCode: 'denied',
        });
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
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'managed_process' }));
      expect(openWorkStore).not.toHaveBeenCalled();
    },
  );
  it('projects validated fields, resolves dependency titles and excludes YAML fences from readable details', () => {
    const document = fixtureDocument();
    document.sources.design += '\n## Pruebas\n```yaml\nkind: SecretLookingData\n```\n';
    vi.mocked(featureDocument).mockReturnValue(document);
    const plan = projectFeaturePlan(
      {
        getFeature: () => ({
          project_id: 'selected',
          key: spec.key,
          doc_path: 'spec.yaml',
          git_sha: 'a'.repeat(40),
          status: 'approved',
        }),
        getTask: vi.fn(),
        getDesign: vi.fn(),
        getFeatureRun: vi.fn(),
      },
      {} as NonNullable<ReturnType<typeof loadProjectConfig>>,
      spec.key,
    );
    expect(plan.summary).toMatchObject({
      goal: spec.goal,
      outOfScope: ['No cambiar permisos'],
      risks: ['Datos incompletos'],
    });
    expect(plan.summary.tasks[1]).toEqual({
      key: dag.tasks[1].key,
      title: 'Mostrar resumen',
      size: 'S',
      dependencies: ['Crear resumen'],
    });
    expect(plan.summary.acceptance[0]).toContain('se lee');
    expect(plan.sections.find((section) => section.id === 'tests')?.items).toEqual([]);
    expect(plan.sections.find((section) => section.id === 'tests')?.content).toContain(
      'kind: SecretLookingData',
    );
    expect(plan.approvalState).toBe('unbound');
  });
  it.each(['finished', 'merged'] as const)(
    'uses WorkStore task completion for %s despite draft YAML and an old binding',
    (state) => {
      vi.mocked(featureDocument).mockReturnValue(fixtureDocument());
      vi.mocked(readMainAncestors).mockReturnValue(new Set(state === 'merged' ? ['head'] : []));
      const plan = projectFeaturePlan(
        {
          getFeature: () => ({
            project_id: 'selected',
            key: spec.key,
            doc_path: 'spec.yaml',
            git_sha: 'a'.repeat(40),
            status: 'approved',
            approved_plan_revision: 'old',
          }),
          getTask: vi.fn().mockReturnValue({ status: 'DONE' }),
          getDesign: vi.fn(),
          getFeatureRun: vi
            .fn()
            .mockReturnValue({ state: { branch: `sa/${spec.key}-integration`, head: 'head' } }),
        },
        { repoRoot: '.' } as NonNullable<ReturnType<typeof loadProjectConfig>>,
        spec.key,
      );
      expect(plan.approvalState).toBe(state);
    },
  );
  it.each(['design', 'dag'] as const)('rejects invalid %s schema data', (field) => {
    const document = fixtureDocument();
    document.sources[field] = 'kind: Invalid';
    vi.mocked(featureDocument).mockReturnValue(document);
    expect(() =>
      projectFeaturePlan(
        {
          getFeature: () => ({
            project_id: 'selected',
            key: spec.key,
            doc_path: 'spec.yaml',
            git_sha: 'a'.repeat(40),
            status: 'in_review',
          }),
          getTask: vi.fn(),
          getDesign: vi.fn(),
          getFeatureRun: vi.fn(),
        },
        {} as NonNullable<ReturnType<typeof loadProjectConfig>>,
        spec.key,
      ),
    ).toThrow();
  });
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
  it.each(['```', '~~~'])(
    'closes a %s fence only with a matching marker and whitespace',
    (marker) => {
      expect(
        designSection(
          `${marker}md\n${marker}still-code\n## Seguridad\nInvented\n${marker} \t\n## Seguridad\nReal`,
          FEATURE_PLAN_HEADINGS.security,
        ),
      ).toBe('## Seguridad\nReal');
    },
  );
});
