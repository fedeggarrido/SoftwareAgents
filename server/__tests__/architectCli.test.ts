import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { architectArtifacts, architectContext, validateArchitect } from '../src/architect.js';
import { AuditLog } from '../src/auditLog.js';
import { runFeatureCommand } from '../src/commands/feature.js';
import { runTaskCommand } from '../src/commands/task.js';
import { EXECUTOR_PROBE_CATALOG } from '../src/executorProbes.js';
import { readRequirements } from '../src/requirements.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import { readyProbeFor } from './helpers/readyProbe.js';

// These tests spawn real processes and Git; on Windows they take ~10 s each.
vi.setConfig({ testTimeout: 90_000 });

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => process.env.HOME ?? actual.homedir()) };
});

let root: string;
let repo: string;
let launches: string;
let executor: 'claude' | 'codex';
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const doc = '.softwareagents/brain/features/FEAT-001.yaml';
const tree = () => path.join(repo, '.worktrees/FEAT-001');
const storeFor = () => openWorkStore({ repositoryPath: repo, projectId: 'test' });
const launchLog = () =>
  fs
    .readFileSync(launches, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
const runSpec = (mode = 'valid', answers = false) =>
  runFeatureCommand(
    [
      'spec',
      'FEAT-001',
      answers ? '--answers' : '--request',
      answers ? 'answers.md' : 'request.md',
    ],
    repo,
    () => {},
    {
      binaryArgs: [
        path.join(__dirname, 'fixtures/fake-requirements-cli.cjs'),
        executor,
        mode,
        launches,
      ],
      probe: readyProbeFor(EXECUTOR_PROBE_CATALOG),
    },
  );
function configure(selected: 'claude' | 'codex') {
  executor = selected;
  fs.writeFileSync(
    path.join(root, '.pixel-agents/config.json'),
    JSON.stringify({
      projects: {
        test: {
          autonomyLevel: 'A1',
          allowedExecutors: [selected],
          binaryPaths: { [selected]: process.execPath },
          quotaThresholds: { [selected]: 0 },
          concurrency: { maxExecutions: 1, perExecutor: { [selected]: 1 } },
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(repo, '.softwareagents/agents/model-policy.yaml'),
    `high_reasoning:\n  - executor: ${selected}\n`,
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'fixture policy');
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'requirements-'));
  repo = path.join(root, 'repo');
  launches = path.join(root, 'launches.jsonl');
  fs.mkdirSync(path.join(repo, '.softwareagents/agents'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.softwareagents/brain'), { recursive: true });
  fs.mkdirSync(path.join(root, '.pixel-agents'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('CODEX_HOME', path.join(root, 'codex'));
  vi.stubEnv('SA_TEST_NO_RATE_LIMIT', '1');
  for (const key of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(key, undefined);
  for (const role of ['AUTHOR', 'COMMITTER']) {
    vi.stubEnv(`GIT_${role}_NAME`, 'Test');
    vi.stubEnv(`GIT_${role}_EMAIL`, 'test@example.invalid');
  }
  git(repo, 'init', '-b', 'main');
  fs.writeFileSync(
    path.join(repo, '.softwareagents/project.yaml'),
    'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: test\nname: Test\nrepo:\n  remote: https://example.invalid/test.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n',
  );
  fs.writeFileSync(path.join(repo, '.softwareagents/brain/RULES.md'), 'Project rules');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n');
  fs.writeFileSync(path.join(repo, 'request.md'), 'FEAT-001: audit view in Command Center.');
  fs.mkdirSync(path.join(repo, '.softwareagents/brain/adr'));
  fs.writeFileSync(path.join(repo, '.softwareagents/brain/adr/0007-existing.md'), '# Existing ADR');
  configure('claude');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
  // Retain isolated fixtures for inspection; never recursively delete a worktree or .vitest-tmp.
});

const designDoc = '.softwareagents/brain/technical-designs/FEAT-001.md';
const dagDoc = '.softwareagents/brain/technical-designs/FEAT-001.dag.yaml';
const designTask = 'FEAT-001-DESIGN';
const design = (mode = 'valid', answers = false) =>
  runFeatureCommand(
    ['design', 'FEAT-001', ...(answers ? ['--answers', 'answers.md'] : [])],
    repo,
    () => {},
    {
      binaryArgs: [
        path.join(__dirname, 'fixtures/fake-architect-cli.cjs'),
        executor,
        mode,
        launches,
      ],
      probe: readyProbeFor(EXECUTOR_PROBE_CATALOG),
    },
  );
async function approved() {
  await runSpec();
  await runFeatureCommand(['approve', 'FEAT-001'], repo, () => {});
  fs.writeFileSync(launches, '');
}

describe.skipIf(process.platform !== 'win32')('Architect CLI via worker (fake CLIs)', () => {
  it.each(['addition', 'omission', 'local change'])(
    'rejects %s against the complete registered DAG',
    async (mode) => {
      await approved();
      await design();
      const file = path.join(tree(), dagDoc);
      const dag = parse(fs.readFileSync(file, 'utf8'));
      if (mode === 'addition') dag.tasks.push({ ...dag.tasks[0], key: 'FEAT-001-T03' });
      if (mode === 'omission') dag.tasks.pop();
      if (mode === 'local change') dag.tasks[0].title = 'Local edit';
      fs.writeFileSync(file, JSON.stringify(dag));
      const store = await storeFor();
      try {
        const before = store.listTasks();
        await expect(runTaskCommand(['import', dagDoc], tree())).rejects.toThrow(
          /registered design; run feature design/,
        );
        await expect(store.importTaskDag(dag, store.getFeature('FEAT-001')!)).rejects.toThrow(
          /registered design/,
        );
        expect(store.listTasks()).toEqual(before);
      } finally {
        store.close();
      }
    },
  );

  it('reserves distinct ADR numbers for two features from the same Brain snapshot', async () => {
    const store = await storeFor();
    const second = await storeFor();
    const proposal = {
      components: ['Reader'],
      risks: [],
      body: 'Design',
      dag: {
        apiVersion: 'softwareagents.io/v1alpha1' as const,
        kind: 'TaskDAG' as const,
        feature: 'FEAT-001',
        tasks: [],
      },
      adrs: [{ title: 'Read only audit', body: 'Decision' }],
    };
    try {
      for (const key of ['FEAT-001', 'FEAT-002'])
        store.createFeature({
          key,
          doc_path: `features/${key}.yaml`,
          git_sha: 'snapshot',
          status: 'approved',
        });
      const [firstFiles, secondFiles] = await Promise.all([
        architectArtifacts(repo, '.softwareagents/brain', 'FEAT-001', proposal, store),
        architectArtifacts(repo, '.softwareagents/brain', 'FEAT-002', proposal, second),
      ]);
      expect([...firstFiles.keys()]).toContain('.softwareagents/brain/adr/0008-read-only-audit.md');
      expect([...secondFiles.keys()]).toContain(
        '.softwareagents/brain/adr/0009-read-only-audit.md',
      );
      expect(await second.reserveAdrNumbers('FEAT-001', 1, 7)).toEqual([8]);
      // No artifact has been written; reservations already survive reopening the store.
      const reopened = await storeFor();
      try {
        expect(await reopened.reserveAdrNumbers('FEAT-002', 1, 7)).toEqual([9]);
      } finally {
        reopened.close();
      }
    } finally {
      store.close();
      second.close();
    }
  });

  it('retries protected changeZones as validation errors exactly once', async () => {
    await approved();
    await design('protected-repair');
    expect(launchLog()).toHaveLength(2);
    expect(launchLog()[1].data.validationErrors.join('\n')).toContain('protected path .git/**');
  });

  it.each(['changeZones', 'testZones'] as const)(
    'accepts ordinary %s despite recursive protected descendants',
    (field) => {
      const spec = { key: 'FEAT-001', acceptance: [{ id: 'AC-001' }] } as Parameters<
        typeof validateArchitect
      >[1];
      for (const exists of [false, true]) {
        for (const zone of ['webview-ui/test', 'e2e/', 'server/src/**']) {
          if (exists)
            fs.mkdirSync(path.join(repo, zone.replace(/\/\*\*$/, '')), { recursive: true });
          const proposal = {
            components: ['Reader'],
            risks: [],
            body: 'Design',
            dag: {
              apiVersion: 'softwareagents.io/v1alpha1',
              kind: 'TaskDAG',
              feature: 'FEAT-001',
              tasks: [
                {
                  key: 'FEAT-001-T01',
                  type: 'code',
                  title: 'Read',
                  description: 'Read',
                  acceptanceRefs: ['AC-001'],
                  dependsOn: [],
                  agentRole: 'developer',
                  size: 'S',
                  changeZones: ['server/src/**'],
                  [field]: [zone],
                  parallelizable: true,
                },
              ],
            },
          };
          expect(
            () =>
              validateArchitect(JSON.stringify(proposal), spec, {
                cwd: repo,
                protectedPaths: ['**/.codex/**'],
              }),
            `${zone} (exists=${exists})`,
          ).not.toThrow();
        }
      }
    },
  );

  it('rejects unsafe zones, physical junction escapes and Operator-protected prefixes', () => {
    const spec = { key: 'FEAT-001', acceptance: [{ id: 'AC-001' }] } as Parameters<
      typeof validateArchitect
    >[1];
    const proposal = {
      components: ['Reader'],
      risks: [],
      body: 'Design',
      dag: {
        apiVersion: 'softwareagents.io/v1alpha1',
        kind: 'TaskDAG',
        feature: 'FEAT-001',
        tasks: [
          {
            key: 'FEAT-001-T01',
            type: 'code',
            title: 'Read',
            description: 'Read',
            acceptanceRefs: ['AC-001'],
            dependsOn: [],
            agentRole: 'developer',
            size: 'S',
            changeZones: ['src/audit*.ts'],
            testZones: ['tests/audit.test.ts'],
            parallelizable: true,
          },
        ],
      },
    };
    const checkout = { cwd: repo, protectedPaths: ['src/secrets/**', 'private/*.key'] };
    for (const zone of ['.git/config', 'private/file.key', '../escape']) {
      expect(() =>
        validateArchitect(
          JSON.stringify({
            ...proposal,
            dag: {
              ...proposal.dag,
              tasks: [{ ...proposal.dag.tasks[0], testZones: [zone] }],
            },
          }),
          spec,
          checkout,
        ),
      ).toThrow();
    }
    const validate = (zone: string) => {
      proposal.dag.tasks[0].changeZones = [zone];
      return () => validateArchitect(JSON.stringify(proposal), spec, checkout);
    };
    for (const zone of [
      '{..,src}/**',
      '.git/config',
      '.softwareagents/brain/file.md',
      'AGENTS.md',
      '**/AGENTS.md',
      'src/secrets/file.ts',
      'src/secrets',
      'foo/.codex/bar',
      'src/**/.codex/*',
      'foo/.git/config',
      'foo/**/AGENTS.md',
      'src/secrets/**',
      'private/file.key/child',
      '.github/workflows/ci.yaml',
    ])
      expect(validate(zone), zone).toThrow();
    for (const zone of [
      'src/audit*.ts',
      'src/module/*.ts',
      'private/*.ts',
      'src/new-file.ts',
      'src/*/file.ts',
      'private/*',
      '**/*.key',
      'src/**',
      'src/**/*.ts',
    ])
      expect(() =>
        validateArchitect(
          JSON.stringify({
            ...proposal,
            dag: { ...proposal.dag, tasks: [{ ...proposal.dag.tasks[0], changeZones: [zone] }] },
          }),
          spec,
          checkout,
        ),
      ).not.toThrow();
    fs.mkdirSync(path.join(repo, 'src'));
    expect(validate('src')).not.toThrow();
    fs.writeFileSync(path.join(repo, 'src/new-file.ts'), '// safe file');
    expect(validate('src/new-file.ts')).not.toThrow();
    expect(validate('src/new-file.ts/*.ts')).toThrow(/prefix must be a directory/);
    fs.symlinkSync(root, path.join(repo, 'escape'), 'junction');
    expect(validate('escape/new/*.ts')).toThrow(/inside|Links/);
  });

  it.each(['claude', 'codex'] as const)(
    'registers design SHA and imports covered DAG through %s',
    async (selected) => {
      if (selected !== executor) configure(selected);
      await approved();
      const store = await storeFor();
      try {
        const feature = store.getFeature('FEAT-001')!;
        await design();
        const record = store.getDesign('FEAT-001')!;
        expect(record).toMatchObject({
          doc_path: designDoc,
          dag_path: dagDoc,
          feature_sha: feature.git_sha,
          git_sha: git(tree(), 'rev-parse', 'HEAD'),
        });
        expect(git(tree(), 'rev-parse', 'HEAD^')).toBe(feature.git_sha);
        expect(store.getFeature('FEAT-001')).toEqual(feature);
        expect(store.getTask(designTask)).toMatchObject({
          status: 'REVIEW',
          agent_role: 'architect',
          branch: 'sa/FEAT-001-worker',
          lease_owner: null,
        });
        expect(store.getTask('FEAT-001-T01')?.status).toBe('READY');
        expect(store.getTask('FEAT-001-T02')?.status).toBe('DRAFT');
        expect(store.listTaskDependencies('FEAT-001-T02')).toMatchObject([
          { depends_on_key: 'FEAT-001-T01' },
        ]);
        expect(JSON.parse(store.getTask('FEAT-001-T01')!.declaration!)).toMatchObject({
          changeZones: ['server/src/audit*.ts'],
          parallelizable: true,
        });
        expect(fs.readFileSync(path.join(tree(), designDoc), 'utf8')).toContain('ADR-0008');
        expect(
          fs.existsSync(path.join(tree(), '.softwareagents/brain/adr/0008-read-only-audit.md')),
        ).toBe(true);
        expect(git(tree(), 'diff', '--name-only', 'HEAD^', 'HEAD').split('\n').sort()).toEqual(
          ['.softwareagents/brain/adr/0008-read-only-audit.md', dagDoc, designDoc].sort(),
        );
        expect(launchLog()[0].data.context).toEqual({
          'ARCHITECTURE.md': null,
          'VISION.md': null,
          'RULES.md': 'Project rules',
          'CONSTRAINTS.md': null,
        });
        expect(launchLog()[0].data.approvedGitSha).toBe(feature.git_sha);
        const args = launchLog()[0].args as string[];
        if (selected === 'codex') expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
        else expect(args[args.indexOf('--allowedTools') + 1]).not.toMatch(/Write|Edit/);
        const before = store.listTasks();
        await design();
        expect(launchLog()).toHaveLength(1);
        const log = vi.fn();
        await runTaskCommand(['import', dagDoc], tree(), log);
        expect(log.mock.calls[0][0]).toContain('0 created');
        expect(store.listTasks()).toEqual(before);
        await runFeatureCommand(['show', 'FEAT-001', '--json'], repo, log);
        expect(JSON.parse(log.mock.calls[1][0]).design).toEqual(record);
      } finally {
        store.close();
      }
    },
  );

  it('corrects one invalid DAG with deterministic coverage diagnostics', async () => {
    await approved();
    await design('repair');
    expect(launchLog()).toHaveLength(2);
    expect(launchLog()[1].data.validationErrors.join('\n')).toContain('uncovered_acceptance');
    const store = await storeFor();
    try {
      expect(store.getDesign('FEAT-001')).toBeDefined();
    } finally {
      store.close();
    }
  });

  it.each(['open', 'answered', 'expired'] as const)(
    'incorporates answers atomically after two invalid attempts (%s decision)',
    async (state) => {
      await approved();
      const store = await storeFor();
      try {
        await design('invalid');
        expect(process.exitCode).toBe(3);
        expect(launchLog()).toHaveLength(2);
        expect(store.getDesign('FEAT-001')).toBeUndefined();
        expect(store.getTask(designTask)).toMatchObject({
          status: 'WAITING_HUMAN',
          lease_owner: null,
        });
        expect(
          store
            .listDomainEvents(designTask)
            .some((event) => event.to_status === 'FAILED_RETRYABLE'),
        ).toBe(false);
        const decision = store.listDecisions()[0];
        expect(decision).toMatchObject({
          requestedBy: 'architect',
          blocks: [designTask],
          status: 'open',
        });
        expect(fs.existsSync(path.join(tree(), designDoc))).toBe(false);
        await design('invalid');
        expect(launchLog()).toHaveLength(2);
        expect(store.listDecisions()).toHaveLength(1);
        if (state === 'answered')
          await store.resolveDecision(decision.id, 'answer', 'operator', () => {});
        if (state === 'expired') await store.resolveDecision(decision.id, null, 'expiry', () => {});
        fs.writeFileSync(
          path.join(repo, 'answers.md'),
          'Cover AC-001. TEST_UNTRUSTED_DESIGN_ANSWERS',
        );
        const append = AuditLog.prototype.append;
        vi.spyOn(AuditLog.prototype, 'append').mockImplementation(function (this: AuditLog, entry) {
          if (entry.outcome.status === 'executor_started') {
            expect(store.getDesign('FEAT-001')).toBeUndefined();
            expect(store.listDecisions()[0].status).toBe(state);
          }
          return append.call(this, entry);
        });
        await design('valid', true);
        expect(store.listDecisions()[0]).toMatchObject({ status: 'answered' });
        expect(JSON.parse(store.listDecisions()[0].answer!)).toMatchObject({
          gitSha: store.getDesign('FEAT-001')!.git_sha,
          answersHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(store.getTask(designTask)?.status).toBe('REVIEW');
        expect(launchLog()[2].data.answers).toContain('TEST_UNTRUSTED_DESIGN_ANSWERS');
        expect(JSON.stringify(new AuditLog().read('test'))).not.toContain(
          'TEST_UNTRUSTED_DESIGN_ANSWERS',
        );
      } finally {
        store.close();
      }
    },
  );

  it('retains the decision and approved SHA if answers produce another invalid DAG', async () => {
    await approved();
    await design('invalid');
    fs.writeFileSync(path.join(repo, 'answers.md'), 'Clarification');
    await design('invalid', true);
    const store = await storeFor();
    try {
      expect(launchLog()).toHaveLength(4);
      expect(store.getTask(designTask)?.status).toBe('WAITING_HUMAN');
      expect(store.listDecisions()).toHaveLength(1);
      expect(store.listDecisions()[0].status).toBe('open');
      expect(store.getDesign('FEAT-001')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it.each(['unapproved', 'sha', 'dirty-spec', 'managed-answers'])(
    'refuses %s before Architect launches',
    async (mode) => {
      await runSpec();
      if (mode !== 'unapproved') await runFeatureCommand(['approve', 'FEAT-001'], repo, () => {});
      fs.writeFileSync(launches, '');
      if (mode === 'sha') git(tree(), 'commit', '--allow-empty', '-m', 'Different SHA');
      if (mode === 'dirty-spec') fs.appendFileSync(path.join(tree(), doc), '# Changed');
      if (mode === 'managed-answers') vi.stubEnv('SA_MANAGED_EXECUTION', '1');
      await expect(design('valid', mode === 'managed-answers')).rejects.toThrow(
        /approved|SHA|human operator/,
      );
      expect(fs.readFileSync(launches, 'utf8')).toBe('');
    },
  );

  it('fails unauthorized writes without retry, commit or import', async () => {
    await approved();
    const sha = git(tree(), 'rev-parse', 'HEAD');
    await expect(design('outside')).rejects.toThrow('containment');
    expect(launchLog()).toHaveLength(1);
    expect(git(tree(), 'rev-parse', 'HEAD')).toBe(sha);
    const store = await storeFor();
    try {
      expect(store.getDesign('FEAT-001')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('validates graph, coverage, paths and strict proposal fields without granting model authority', async () => {
    await approved();
    await design();
    const spec = readRequirements(tree(), doc, 'FEAT-001');
    const { parse } = await import('yaml');
    const dag = parse(fs.readFileSync(path.join(tree(), dagDoc), 'utf8'));
    const valid = { components: ['Reader'], risks: [], body: 'Design', dag };
    for (const mutate of [
      (p: typeof valid) => {
        p.dag.tasks[0].acceptanceRefs = [];
        p.dag.tasks[1].acceptanceRefs = [];
      },
      (p: typeof valid) => {
        p.dag.tasks[0].dependsOn = ['FEAT-001-T02'];
      },
      (p: typeof valid) => {
        p.dag.tasks[0].dependsOn = ['FEAT-001-T99'];
      },
      (p: typeof valid) => {
        p.dag.tasks[1].key = p.dag.tasks[0].key;
      },
      (p: typeof valid) => {
        p.dag.tasks[0].key = 'FEAT-002-T01';
      },
      (p: typeof valid) => {
        p.dag.tasks[0].key = '../../escape';
      },
      (p: typeof valid) => {
        delete p.dag.tasks[0].changeZones;
      },
      (p: typeof valid) => {
        delete p.dag.tasks[0].parallelizable;
      },
      (p: typeof valid) => {
        p.dag.tasks[0].changeZones = ['../escape'];
      },
      (p: typeof valid) => {
        p.dag.tasks[0].changeZones = ['C:/escape'];
      },
    ]) {
      const proposal = structuredClone(valid);
      mutate(proposal);
      expect(() => validateArchitect(JSON.stringify(proposal), spec, { cwd: tree() })).toThrow();
    }
    for (const forbidden of [
      { path: 'outside.md' },
      { adrs: [{ title: 'Decision', body: 'Content', path: 'outside.md' }] },
    ])
      expect(() =>
        validateArchitect(JSON.stringify({ ...valid, ...forbidden }), spec, { cwd: tree() }),
      ).toThrow();
    const store = await storeFor();
    try {
      await expect(
        architectArtifacts(tree(), '.softwareagents/brain', 'FEAT-001', valid, store),
      ).rejects.toThrow('already exists');
    } finally {
      store.close();
    }
    expect(architectContext(tree(), '.softwareagents/brain')['ARCHITECTURE.md']).toBeNull();
    fs.symlinkSync(root, path.join(tree(), '.softwareagents/brain/ARCHITECTURE.md'), 'junction');
    expect(() => architectContext(tree(), '.softwareagents/brain')).toThrow(/Links|inside/);
  });
});
