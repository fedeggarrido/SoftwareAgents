import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import type { FeatureSpec } from '../../core/src/featureSpec.js';
import type { DagTask } from '../../core/src/taskDag.js';
import { compileAgent } from '../src/agentCompiler.js';
import { architectBrief, architectContext, validateArchitect } from '../src/architect.js';
import { AuditLog } from '../src/auditLog.js';
import { validateChangeZone } from '../src/changeZones.js';
import { developerRequest, prepareDeveloperRequest } from '../src/developer.js';
import { assertEvalIntegrity } from '../src/evalIntegrity.js';
import { HumanDecisions } from '../src/humanDecisions.js';
import {
  guardIntegrationCatalog,
  integrationCatalogAtRef,
  integrationCatalogPath,
  integrationWritablePaths,
  parseIntegrationCatalog,
} from '../src/integrationCatalog.js';
import { requireIntegrationAccess } from '../src/integrationDecisions.js';
import { loadProjectConfig } from '../src/projectConfig.js';
import { parseTaskDag, taskDeclaration } from '../src/taskDag.js';
import { runWorker } from '../src/worker.js';
import { loadWorkerAgentSpec, workerRole } from '../src/workerSupport.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import type { WorkStore } from '../src/workstore/WorkStore.js';
import { removeTempDir } from './helpers/removeTempDir.js';

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: () => process.env.HOME! };
});

const brain = '.softwareagents/brain';
const catalogPath = integrationCatalogPath(brain);
const task: DagTask = {
  key: 'FEAT-001-T01',
  type: 'code',
  title: 'adapters/out cliente de pagos',
  description: 'Implementar el cliente de pagos con contratos tipados',
  acceptanceRefs: ['AC-001'],
  dependsOn: [],
  agentRole: 'integrations',
  externalServices: ['payments'],
  size: 'M',
  changeZones: ['src/adapters/out/payments/**', catalogPath],
  parallelizable: false,
};
const spec: FeatureSpec = {
  apiVersion: 'softwareagents.io/v1alpha1',
  kind: 'FeatureSpec',
  key: 'FEAT-001',
  version: '1.0.0',
  status: 'approved',
  title: 'Pagos',
  goal: 'Consultar pagos',
  userValue: 'Ver los pagos',
  actors: ['Operador'],
  flows: ['Consultar pagos'],
  rules: [],
  edgeCases: [],
  openQuestions: [],
  links: { adr: [], clickup: [] },
  acceptance: [{ id: 'AC-001', given: 'Un pago', when: 'Se consulta', then: 'Es visible' }],
};
const entry = {
  service: 'payments',
  port: 'src/application/ports/payments.ts',
  auth: 'OAuth mediante secret manager',
  limits: 'Según contrato del proveedor',
  owner: 'Equipo de pagos',
};
const dag = {
  apiVersion: 'softwareagents.io/v1alpha1',
  kind: 'TaskDAG',
  feature: spec.key,
  tasks: [task],
};

let root: string;
let store: WorkStore;
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'pipe',
  }).trim();
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-integrations-'));
  for (const key of ['HOME', 'USERPROFILE']) vi.stubEnv(key, root);
  for (const key of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(key, undefined);
  for (const role of ['AUTHOR', 'COMMITTER']) {
    vi.stubEnv(`GIT_${role}_NAME`, 'Test');
    vi.stubEnv(`GIT_${role}_EMAIL`, 'test@example.invalid');
  }
  git('init', '-b', 'main');
  fs.mkdirSync(path.join(root, brain), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# Proyecto\n');
  git('add', '.');
  git('commit', '-m', 'fixture');
  store = await openWorkStore({ repositoryPath: root, projectId: 'test' });
  store.createTask({ key: task.key, type: 'code', agent_role: 'integrations', status: 'READY' });
});
afterEach(async () => {
  store?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
  await removeTempDir(root);
});

describe('SA-159 integrations policy', () => {
  it('compiles the full integration policy with developer execution permissions', () => {
    const compiled = compileAgent(loadWorkerAgentSpec(undefined, 'integrations'), 'integrations', {
      task,
    });
    const developer = compileAgent(loadWorkerAgentSpec(), 'developer', { task });
    expect(compiled.claude.allowedTools).toEqual(developer.claude.allowedTools);
    expect(compiled.claude.disallowedTools).toEqual(developer.claude.disallowedTools);
    expect(compiled.codex.sandbox).toEqual(developer.codex.sandbox);
    for (const policy of [
      'one client per external service',
      'application port',
      'src/adapters/out',
      'timeouts',
      'backoff only for idempotent',
      'idempotency keys',
      'rate limits',
      'circuit breaker',
      'pagination',
      'typed errors mapped to domain errors',
      'logs without secrets',
      'project config or a secret manager',
      'never in code, logs or prompts',
      'OpenAPI',
      'contract tests plus fakes',
      'provider sandbox',
      'duplicated or inconsistent calls',
      'Never decide or answer',
      'create accounts or create real keys',
    ])
      expect(compiled.systemPrompt).toContain(policy);
    expect(compiled.systemPrompt).toContain('Quality rules (mandatory');
    expect(
      workerRole({
        developer: {
          key: spec.key,
          approvedSpec: spec,
          featureSha: 'spec',
          designSha: 'design',
          design: 'Diseño',
          task,
        },
      }),
    ).toBe('integrations');
  });

  it('validates the architect role, services and exact catalog zone with a custom Brain', () => {
    const validate = (candidate: DagTask, selectedBrain = brain) =>
      validateArchitect(
        JSON.stringify({
          architecture: { kind: 'hexagonal' },
          components: ['Cliente'],
          risks: [],
          body: 'Diseño',
          dag: { ...dag, tasks: [candidate] },
        }),
        spec,
        { cwd: root, brain: selectedBrain },
      );
    expect(validate(task).dag.tasks[0].agentRole).toBe('integrations');
    expect(() => validate({ ...task, agentRole: 'developer' })).toThrow(/agentRole integrations/);
    expect(() => validate({ ...task, externalServices: undefined })).toThrow(/externalServices/);
    expect(() => validate({ ...task, changeZones: ['src/adapters/out/**'] })).toThrow(
      /integrations.yaml/,
    );
    expect(() =>
      validate({ ...task, changeZones: ['src/**', catalogPath], agentRole: 'developer' }),
    ).toThrow(/integrations/);
    const custom = {
      ...task,
      changeZones: ['src/adapters/out/**', 'docs/brain/integrations.yaml'],
    };
    expect(() => validate(custom, 'docs/brain')).not.toThrow();
    const context = architectContext(root, 'docs/brain');
    expect(
      JSON.parse(architectBrief({ key: spec.key, spec, gitSha: 'spec' }, context))
        .integrationCatalogPath,
    ).toBe('docs/brain/integrations.yaml');
  });

  it('binds service ids immutably and rejects malformed or duplicate declarations', () => {
    expect(taskDeclaration(spec.key, task)).not.toBe(
      taskDeclaration(spec.key, { ...task, externalServices: ['other'] }),
    );
    for (const externalServices of [['Payments'], ['payments', 'payments'], []])
      expect(() => parseTaskDag({ ...dag, tasks: [{ ...task, externalServices }] })).toThrow();
  });

  it('opens one decision atomically and blocks the task before a claim', async () => {
    const check = () => requireIntegrationAccess(store, spec.key, task, 'design-sha', []);
    expect(await Promise.all([check(), check()])).toEqual([false, false]);
    expect(store.listDecisions()).toHaveLength(1);
    expect(store.listDecisions()[0].blocks).toEqual([task.key]);
    expect(store.listDecisions()[0].context).toContain('payments');
    expect(store.getTask(task.key)?.status).toBe('WAITING_HUMAN');
    await expect(store.claim(task.key, 'worker')).rejects.toThrow();
    expect(store.listExecutions()).toEqual([]);
    expect(await check()).toBe(false);
  });

  it('uses developer retry accounting and the same attempt ceiling', async () => {
    const key = 'FEAT-001-T03';
    store.createTask({
      key,
      type: 'code',
      agent_role: 'integrations',
      status: 'READY',
      max_attempts: 2,
    });
    for (const attempt of [0, 1]) {
      const leased = await store.claim(key, 'worker');
      expect(leased.attempt).toBe(attempt);
      const running = await store.transition(key, leased.version, 'RUNNING', 'start', 'worker');
      await store.transition(
        key,
        running.version,
        'FAILED_RETRYABLE',
        'Implementation failed',
        'worker',
      );
    }
    await expect(store.claim(key, 'worker')).rejects.toThrow(/max_attempts/);
  });

  it('rejects managed-agent answers through both HumanDecisions entry points', async () => {
    await requireIntegrationAccess(store, spec.key, task, 'design-sha', []);
    const id = store.listDecisions()[0].id;
    const decisions = new HumanDecisions(store, new AuditLog());
    vi.stubEnv('SA_MANAGED_EXECUTION', '1');
    await expect(decisions.answer(id, 'allow', true, 'agent', 'A3')).rejects.toThrow(/humano/);
    await expect(decisions.reconcile(id, 'allow', true, 'agent', 'A3')).rejects.toThrow(/humano/);
    expect(store.getTask(task.key)?.status).toBe('WAITING_HUMAN');
    vi.stubEnv('SA_MANAGED_EXECUTION', undefined);
    await expect(decisions.answer(id, 'allow', false, 'agent', 'A3')).rejects.toThrow(/operator/);
    await decisions.answer(id, 'allow', true, 'fede', 'A3');
    expect(await requireIntegrationAccess(store, spec.key, task, 'design-sha', [])).toBe(true);
    expect(store.getTask(task.key)?.status).toBe('READY');
    expect(await requireIntegrationAccess(store, spec.key, task, 'another-design', [])).toBe(false);
  });

  it('retains denial and pending gates even if a service appears in the catalog', async () => {
    await requireIntegrationAccess(store, spec.key, task, 'design-sha', []);
    expect(await requireIntegrationAccess(store, spec.key, task, 'design-sha', [entry])).toBe(
      false,
    );
    await new HumanDecisions(store).answer(store.listDecisions()[0].id, 'deny', true, 'fede', 'A1');
    expect(await requireIntegrationAccess(store, spec.key, task, 'design-sha', [entry])).toBe(
      false,
    );
  });

  it('allows cataloged services and ordinary developer work without opening a decision', async () => {
    expect(await requireIntegrationAccess(store, spec.key, task, 'design-sha', [entry])).toBe(true);
    expect(
      await requireIntegrationAccess(
        store,
        spec.key,
        { ...task, agentRole: 'developer' },
        'design-sha',
        [],
      ),
    ).toBe(true);
    expect(store.listDecisions()).toEqual([]);
  });

  // The worker supports Windows process-tree recovery only.
  it.skipIf(process.platform !== 'win32')(
    'enforces the new-service gate through the real worker entry before leasing or execution',
    async () => {
      const feature = 'FEAT-002';
      const declaration = { ...task, key: `${feature}-T01` };
      const registeredDag = parseTaskDag({ ...dag, feature, tasks: [declaration] });
      const manifest = {
        apiVersion: 'softwareagents.io/v1alpha1',
        kind: 'Project',
        id: 'test',
        name: 'Test',
        repo: { remote: 'https://example.invalid/test.git', defaultBranch: 'main' },
        brain: { path: brain },
      };
      fs.writeFileSync(path.join(root, '.softwareagents/project.yaml'), stringify(manifest));
      fs.mkdirSync(path.join(root, '.pixel-agents'));
      fs.writeFileSync(
        path.join(root, '.pixel-agents/config.json'),
        JSON.stringify({
          projects: { test: { autonomyLevel: 'A1', allowedExecutors: ['codex'] } },
        }),
      );
      const tree = path.join(root, `.worktrees/${feature}`);
      const branch = `sa/${feature}-worker`;
      git('worktree', 'add', '-b', branch, tree);
      const requirements = `${brain}/features/${feature}.yaml`;
      fs.mkdirSync(path.join(tree, brain, 'features'), { recursive: true });
      fs.writeFileSync(
        path.join(tree, requirements),
        stringify({
          ...spec,
          key: feature,
          status: 'draft',
          acceptance: [
            {
              ...spec.acceptance[0],
              ears: 'When a payment is requested, the system shall display the payment.',
            },
          ],
        }),
      );
      git('-C', tree, 'add', '.');
      git('-C', tree, 'commit', '-m', 'requirements');
      const featureSha = git('-C', tree, 'rev-parse', 'HEAD');
      const docPath = `${brain}/technical-designs/${feature}.md`;
      const dagPath = `${brain}/technical-designs/${feature}.dag.yaml`;
      fs.mkdirSync(path.join(tree, brain, 'technical-designs'));
      fs.writeFileSync(path.join(tree, docPath), '# Diseño\n');
      fs.writeFileSync(path.join(tree, dagPath), stringify(registeredDag));
      git('-C', tree, 'add', '.');
      git('-C', tree, 'commit', '-m', 'design');
      const designSha = git('-C', tree, 'rev-parse', 'HEAD');
      store.createTask({
        key: feature,
        type: 'docs',
        status: 'REVIEW',
        branch,
        worktree_ref: tree,
      });
      store.createTask({
        key: `${feature}-DESIGN`,
        type: 'architecture',
        status: 'READY',
        agent_role: 'architect',
      });
      await store.claim(`${feature}-DESIGN`, 'architect');
      await store.importTaskDag(
        registeredDag,
        {
          key: feature,
          status: 'approved',
          git_sha: featureSha,
          doc_path: requirements,
        },
        {
          owner: 'architect',
          design: {
            feature_key: feature,
            feature_sha: featureSha,
            git_sha: designSha,
            doc_path: docPath,
            dag_path: dagPath,
          },
        },
      );
      const config = loadProjectConfig(root, true)!;
      const input = developerRequest(store, config, feature, declaration.key);
      await runWorker({ task: declaration.key }, { cwd: root, developer: input, log: () => {} });
      expect(store.getTask(declaration.key)).toMatchObject({
        status: 'WAITING_HUMAN',
        lease_owner: null,
      });
      expect(store.listExecutions()).toEqual([]);
      const decision = store.listDecisions()[0];
      await new HumanDecisions(store).answer(decision.id, 'allow', true, 'fede', 'A1');
      expect((await prepareDeveloperRequest(store, config, input))?.task.agentRole).toBe(
        'integrations',
      );
    },
  );

  it('reads the trusted Git catalog, ignoring uncommitted task metadata', () => {
    fs.writeFileSync(path.join(root, catalogPath), stringify([entry]));
    expect(integrationCatalogAtRef(root, brain, 'HEAD')).toEqual([]);
    git('add', '.');
    git('commit', '-m', 'catalog');
    expect(integrationCatalogAtRef(root, brain, 'HEAD')).toEqual([entry]);
  });

  it('requires each service and all catalog fields, rejecting duplicate service ids', () => {
    expect(() => guardIntegrationCatalog(task, brain, root, 'HEAD')).toThrow(/Falta el catálogo/);
    fs.writeFileSync(path.join(root, catalogPath), '[]');
    expect(() => guardIntegrationCatalog(task, brain, root, 'HEAD')).toThrow(/payments/);
    fs.writeFileSync(path.join(root, catalogPath), stringify([entry]));
    expect(() => guardIntegrationCatalog(task, brain, root, 'HEAD')).not.toThrow();
    fs.writeFileSync(
      path.join(root, catalogPath),
      stringify([entry, { ...entry, service: 'other' }]),
    );
    expect(() => guardIntegrationCatalog(task, brain, root, 'HEAD')).toThrow(/decisión humana/);
    expect(() => parseIntegrationCatalog(stringify([{ service: 'payments' }]))).toThrow();
    expect(() => parseIntegrationCatalog(stringify([entry, entry]))).toThrow(/duplicados/);
  });

  it('rejects catalog changes from any other role, even with a zone covering the brain', () => {
    const doc = { ...task, agentRole: 'developer', type: 'doc' as const, externalServices: [] };
    expect(() => guardIntegrationCatalog(doc, brain, root, 'HEAD')).not.toThrow();
    fs.writeFileSync(path.join(root, catalogPath), stringify([entry]));
    expect(() => guardIntegrationCatalog(doc, brain, root, 'HEAD')).toThrow(/integraciones/);
    git('add', '.');
    git('commit', '-m', 'catalog');
    expect(() => guardIntegrationCatalog(doc, brain, root, 'HEAD')).not.toThrow();
  });

  it('permits only the catalog metadata path while preserving operator protections', () => {
    const paths = integrationWritablePaths(task, brain);
    expect(() => validateChangeZone(root, catalogPath, [], paths)).not.toThrow();
    expect(() => validateChangeZone(root, '.softwareagents/hexagonal.json', [], paths)).toThrow(
      /protected/,
    );
    expect(() => validateChangeZone(root, catalogPath, [catalogPath], paths)).toThrow(/protected/);
    const checkout = path.join(root, 'checkout');
    git('worktree', 'add', '--detach', checkout);
    fs.mkdirSync(path.join(checkout, brain), { recursive: true });
    fs.writeFileSync(path.join(checkout, catalogPath), stringify([entry]));
    const integrity = { baseCommit: git('rev-parse', 'HEAD'), writableMetadataPaths: paths };
    expect(() => assertEvalIntegrity(integrity, checkout)).not.toThrow();
    expect(() => assertEvalIntegrity({ baseCommit: integrity.baseCommit }, checkout)).toThrow(
      /forbidden/,
    );
    fs.writeFileSync(path.join(checkout, '.softwareagents/hexagonal.json'), '{}');
    expect(() => assertEvalIntegrity(integrity, checkout)).toThrow(/forbidden/);
  });
});
