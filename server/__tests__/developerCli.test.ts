import { DatabaseSync } from 'node:sqlite';

import { execFileSync } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { AuditLog } from '../src/auditLog.js';
import { matchesChangeZone, validateChangeZone } from '../src/changeZones.js';
import { runFeatureCommand } from '../src/commands/feature.js';
import { runTaskCommand } from '../src/commands/task.js';
import {
  ChangeZonesExceededError,
  type DeveloperRequest,
  developerScope,
  developerStyleCommands,
  guardDeveloperChanges,
  lastDeveloperFailure,
  pushDeveloperBranch,
} from '../src/developer.js';
import { EXECUTOR_PROBE_CATALOG } from '../src/executorProbes.js';
import { guardProtectedPaths } from '../src/executors/protectedPaths.js';
import { WorktreeManager } from '../src/executors/worktreeManager.js';
import * as modelCascade from '../src/modelCascade.js';
import { checkCascadeCriteria } from '../src/modelCascade.js';
import { loadProjectConfig } from '../src/projectConfig.js';
import { qaTestFiles } from '../src/qa.js';
import type { ReviewerRequest } from '../src/reviewer.js';
import { taskBranchBase } from '../src/taskBranchBase.js';
import * as taskTests from '../src/taskTestRunner.js';
import type { VerifierFailure } from '../src/verifierFeedback.js';
import { VerifierInfrastructureError } from '../src/verifierInfrastructure.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import { developerVerifierConfig } from './helpers/developerVerifierConfig.js';
import { operatorToken } from './helpers/operatorToken.js';
import { readyProbeFor } from './helpers/readyProbe.js';

// Each case runs real Git plus a nested Vitest; under full-suite load on Windows this exceeds 30 s.
vi.setConfig({ testTimeout: 300_000 });
// Fresh worktrees have dependencies through junctions, but no ignored dist output.
// Build the real mandatory hook locally; never borrow another checkout's build.
beforeAll(() => {
  buildSync({
    entryPoints: [path.resolve(__dirname, '../src/executors/containmentHook.ts')],
    outfile: path.resolve(__dirname, '../../dist/hooks/containment-hook.js'),
    bundle: true,
    platform: 'node',
    target: 'node20',
  });
});
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));
let root: string;
let repo: string;
let launches: string;
let executor: 'claude' | 'codex';
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const task = 'FEAT-001-T01';
const tree = () => path.join(repo, '.worktrees', task);
const storeFor = () => openWorkStore({ repositoryPath: repo, projectId: 'test' });
function detachedTree(): string {
  const directory = path.join(root, 'guard-tree');
  git(repo, 'worktree', 'add', '--detach', directory, 'main');
  return directory;
}

it('allows documentation without tests, rejecting product and out-of-zone markdown', () => {
  const base = git(repo, 'rev-parse', 'HEAD');
  const directory = detachedTree();
  const input = {
    task: { type: 'doc', agentRole: 'developer', changeZones: ['docs/'] },
  } as DeveloperRequest;
  fs.mkdirSync(path.join(directory, 'docs'));
  fs.writeFileSync(path.join(directory, 'docs/guide.md'), '# Guide\n');
  const check = () => guardDeveloperChanges(input, loadProjectConfig(repo, true)!, directory, base);
  expect(check()).toEqual([]);
  fs.writeFileSync(path.join(directory, 'outside.md'), '# Outside\n');
  expect(check).toThrow(ChangeZonesExceededError);
  fs.unlinkSync(path.join(directory, 'outside.md'));
  fs.mkdirSync(path.join(directory, 'server/src'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'server/src/product.ts'), 'export const x = 1;\n');
  input.task.changeZones!.push('server/');
  expect(check).toThrow(ChangeZonesExceededError);
});

it('rejects empty scratch directories before verifiers', () => {
  const base = git(repo, 'rev-parse', 'HEAD');
  const directory = detachedTree();
  fs.mkdirSync(path.join(directory, 'scratch'));
  const input = { task: { type: 'doc', changeZones: ['docs/'] } } as DeveloperRequest;
  expect(() =>
    guardDeveloperChanges(input, loadProjectConfig(repo, true)!, directory, base),
  ).toThrow('temporary_directory: scratch');
});
function configure(
  push?: { enabled: boolean; remote: string },
  selected: 'claude' | 'codex' = 'claude',
) {
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
          ...(push ? { developer: { pushBranch: push } } : {}),
        },
      },
    }),
  );
}

// These scenarios launch worker run, whose process-tree recovery requires Windows.
it.skipIf(process.platform !== 'win32')(
  'corrects a misplaced test for free on the same tree before verification',
  async () => {
    await prepare();
    enableGuardCascade();
    await develop('misplaced');
    const calls = fs
      .readFileSync(launches, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(2);
    expect(calls[1].cwd).toBe(calls[0].cwd);
    expect(JSON.parse(calls[1].context.task.brief).guardCorrection).toMatchObject({
      category: 'change_zones_exceeded',
      paths: ['server/src/audit.test.ts'],
    });
    const store = await storeFor();
    try {
      expect(store.getTask(task)).toMatchObject({ status: 'REVIEW', attempt: 0 });
    } finally {
      store.close();
    }
    const corrections = new AuditLog()
      .read('test')
      .filter((row) => !row.corrupt && row.entry.outcome.status === 'guard_correction');
    expect(corrections).toHaveLength(2);
    expect(cascadeAttempts()).toEqual([expect.objectContaining({ attempt: 1, result: 'pass' })]);
  },
);

it.skipIf(process.platform !== 'win32')(
  'bounds a failed free correction and retains normal retry accounting',
  async () => {
    await prepare();
    enableGuardCascade();
    await expect(develop('misplaced-always')).rejects.toThrow('changeZones exceeded');
    expect(fs.readFileSync(launches, 'utf8').trim().split('\n')).toHaveLength(2);
    const store = await storeFor();
    try {
      expect(store.getTask(task)).toMatchObject({ status: 'FAILED_RETRYABLE', attempt: 0 });
    } finally {
      store.close();
    }
    expect(cascadeAttempts()).toEqual([
      expect.objectContaining({ attempt: 1, result: 'guard_rejected' }),
    ]);
  },
);

function enableGuardCascade() {
  const file = path.join(root, '.pixel-agents/config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.projects.test.modelTiers = {
    rule: parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../.softwareagents/agents/model-policy.yaml'),
        'utf8',
      ),
    ).tierRule,
    maxTier: 'standard',
    tiers: {
      economy: { candidates: [{ executor: 'claude', model: 'haiku' }] },
      standard: { candidates: [{ executor: 'claude', model: 'sonnet' }] },
    },
    cascade: {
      enabled: true,
      startTier: 'economy',
      maxEscalations: 1,
      verifiers: {},
      defaultVerifier: { commands: [{ vitestRelated: true, timeoutMs: 30_000 }] },
    },
  };
  fs.writeFileSync(file, JSON.stringify(config));
}

function cascadeAttempts() {
  return fs
    .readFileSync(path.join(repo, '.git/softwareagents/cascade-attempts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

it.skipIf(process.platform !== 'win32')(
  'relaunches Codex after a contained shell write without relaxing containment',
  async () => {
    configure(undefined, 'codex');
    await prepare();
    await develop('shell-denied');
    const calls = fs
      .readFileSync(launches, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1].context.task.brief).guardCorrection.detail).toContain(
      'usa apply_patch/Edit',
    );
    const store = await storeFor();
    try {
      expect(store.getTask(task)).toMatchObject({ status: 'REVIEW', attempt: 0 });
    } finally {
      store.close();
    }
  },
);

it.skipIf(process.platform !== 'win32')(
  'rejects nested Git before starting any verifier',
  async () => {
    await prepare();
    const verifier = vi.spyOn(modelCascade, 'checkCascadeCriteria');
    await expect(develop('nested-git')).rejects.toThrow(/nested .git/);
    expect(verifier).not.toHaveBeenCalled();
    expect(fs.readFileSync(launches, 'utf8').trim().split('\n')).toHaveLength(2);
  },
);
const run = (command: string[], fixture = 'developer', mode = 'valid') =>
  runFeatureCommand(command, repo, () => {}, {
    binaryArgs: [
      path.join(__dirname, `fixtures/fake-${fixture}-cli.cjs`),
      executor,
      mode,
      launches,
    ],
    probe: readyProbeFor(EXECUTOR_PROBE_CATALOG),
  });
const develop = (mode = 'valid', explicit = true) =>
  run(['develop', 'FEAT-001', ...(explicit ? ['--task', task] : [])], 'developer', mode);
async function prepare(approve = true, design = true, designMode = 'valid') {
  await run(['spec', 'FEAT-001', '--request', 'request.md'], 'requirements');
  if (approve) await runFeatureCommand(['approve', 'FEAT-001'], repo, () => {});
  if (approve && design) await run(['design', 'FEAT-001'], 'architect', designMode);
  fs.writeFileSync(launches, '');
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'developer-'));
  repo = path.join(root, 'repo');
  launches = path.join(root, 'launches.jsonl');
  fs.mkdirSync(path.join(repo, '.softwareagents/agents'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.softwareagents/brain'), { recursive: true });
  fs.mkdirSync(path.join(root, '.pixel-agents'));
  for (const key of ['HOME', 'USERPROFILE']) vi.stubEnv(key, root);
  operatorToken(root);
  vi.stubEnv('CODEX_HOME', path.join(root, 'codex'));
  vi.stubEnv('SA_TEST_NO_RATE_LIMIT', '1');
  for (const key of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(key, undefined);
  for (const role of ['AUTHOR', 'COMMITTER']) {
    vi.stubEnv(`GIT_${role}_NAME`, 'Test');
    vi.stubEnv(`GIT_${role}_EMAIL`, 'test@example.invalid');
  }
  git(repo, 'init', '-b', 'main');
  developerVerifierConfig(repo);
  fs.writeFileSync(
    path.join(repo, '.softwareagents/project.yaml'),
    'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: test\nname: Test\nrepo:\n  remote: https://example.invalid/test.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n',
  );
  fs.writeFileSync(
    path.join(repo, '.softwareagents/agents/model-policy.yaml'),
    'high_reasoning:\n  - executor: claude\n  - executor: codex\nstandard_coding:\n  - executor: claude\n  - executor: codex\nreview:\n  - executor: claude\n  - executor: codex\n',
  );
  fs.writeFileSync(path.join(repo, 'request.md'), 'Audit view');
  fs.writeFileSync(
    path.join(repo, 'tsconfig.json'),
    '{"compilerOptions":{"noEmit":true},"include":["server/src/**/*.ts"]}',
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'fixture');
  configure();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
});

describe('Developer diff guard', () => {
  it('autofixes unsorted imports and CRLF using the real repository config, scoped to touched files', async () => {
    // A real e2e source, without launching Playwright or any executor.
    const realRepo = path.resolve(__dirname, '../..');
    for (const name of [
      '.prettierrc.json',
      '.prettierignore',
      '.editorconfig',
      'eslint.config.mjs',
    ])
      fs.copyFileSync(path.join(realRepo, name), path.join(repo, name));
    fs.cpSync(path.join(realRepo, 'eslint-rules'), path.join(repo, 'eslint-rules'), {
      recursive: true,
    });
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'real style configuration');
    const base = git(repo, 'rev-parse', 'HEAD');
    const directory = detachedTree();
    const file = 'e2e/tests/standalone/hooks.spec.ts';
    vi.spyOn(taskTests, 'runTaskTest').mockResolvedValue({
      result: 'pass',
      passed: 1,
      failed: 0,
    });
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    const source = fs.readFileSync(path.join(realRepo, file), 'utf8');
    fs.writeFileSync(path.join(directory, file), source);
    const failures: VerifierFailure[] = [];
    // The isolated command must agree with a normal root invocation on the same real spec.
    const normal = execFileSync(
      process.execPath,
      [require.resolve('prettier/bin/prettier.cjs'), '--check', '--ignore-unknown', file],
      { cwd: realRepo, encoding: 'utf8', windowsHide: true },
    );
    expect(normal).toContain('All matched files');
    expect(
      await checkCascadeCriteria(
        { commands: developerStyleCommands(directory, base).slice(0, 1) },
        base,
        directory,
        root,
        new AbortController().signal,
        undefined,
        [file],
        base,
        { failures },
      ),
    ).toEqual(['pass', 'pass']);
    // Runtime/agent writes can introduce CRLF even though the checkout uses eol=lf.
    fs.writeFileSync(path.join(directory, file), source.replace(/\r?\n/g, '\r\n'));
    expect(
      await checkCascadeCriteria(
        { commands: developerStyleCommands(directory, base).slice(0, 1) },
        base,
        directory,
        root,
        new AbortController().signal,
        undefined,
        [file],
        base,
        { failures },
      ),
    ).toEqual(['fail', 'pass']);
    expect(failures[0]).toMatchObject({ verifier: 'prettier', files: [file] });
    const untouched = path.join(directory, 'server/src/baseline.ts');
    const before = fs.readFileSync(untouched);
    fs.writeFileSync(
      path.join(directory, file),
      "import z from 'z';\r\nimport a from 'a';\r\nexport const answer=1\r\n",
    );
    expect(
      await checkCascadeCriteria(
        { commands: developerStyleCommands(directory, base) },
        base,
        directory,
        root,
        new AbortController().signal,
        undefined,
        [file],
        base,
        { failures: [], autoFix: () => {} },
      ),
    ).toEqual(['pass', 'pass', 'pass', 'pass', 'pass']);
    expect(fs.readFileSync(path.join(directory, file), 'utf8')).toBe(
      "import a from 'a';\nimport z from 'z';\nexport const answer = 1;\n",
    );
    expect(fs.readFileSync(untouched)).toEqual(before);
  });
  it.each([
    ['webview-ui/test/Panel.test.ts', true],
    ['webview-ui/test/nested/Panel.test.ts', false],
    ['server/__tests__/Panel.spec.ts', false],
    ['e2e/outside.spec.ts', false],
  ])('Developer guard and QA agree on discovery for %s', (file, executed) => {
    const base = git(repo, 'rev-parse', 'HEAD');
    const directory = detachedTree();
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(
      path.join(directory, file),
      "import { it, expect } from 'vitest';\nit('fixture', () => expect(true).toBe(true));\n",
    );
    git(directory, 'add', file);
    const input = { task: { changeZones: [file] } } as DeveloperRequest;
    const guard = () =>
      guardDeveloperChanges(input, loadProjectConfig(repo, true)!, directory, base);
    const qa = () =>
      qaTestFiles({ ...input, files: [file], worktree: directory } as ReviewerRequest);
    if (executed) {
      expect(guard()).toEqual([file]);
      expect(qa()).toEqual([file]);
    } else {
      expect(guard).toThrow(ChangeZonesExceededError);
      expect(qa).toThrow(file);
    }
  });
  it('documents exact mirror variants for literal source zones and reports all foreign paths escaped', () => {
    const base = git(repo, 'rev-parse', 'HEAD');
    const directory = detachedTree();
    const input = {
      task: { changeZones: ['server/src/clientMessageHandler.ts'] },
    } as DeveloperRequest;
    expect(developerScope(input.task, repo).mirroredTestZones).toEqual([
      'server/__tests__/clientMessageHandler*.test.ts',
    ]);
    // Webview tests are flat and named after the source file (same mirror as QA).
    expect(
      developerScope({ changeZones: ['webview-ui/src/office/featuresStore.ts'] } as never, repo)
        .mirroredTestZones,
    ).toEqual(['webview-ui/test/featuresStore*.test.ts']);
    fs.mkdirSync(path.join(directory, 'server/__tests__'), { recursive: true });
    const allowed = 'server/__tests__/clientMessageHandlerWs.test.ts';
    fs.writeFileSync(
      path.join(directory, allowed),
      "it('mirror', () => expect(true).toBe(true));\n",
    );
    expect(guardDeveloperChanges(input, loadProjectConfig(repo, true)!, directory, base)).toEqual([
      allowed,
    ]);
    const foreign = ['server/__tests__/auditLogWs.test.ts', 'other.txt'];
    for (const file of foreign) fs.writeFileSync(path.join(directory, file), 'foreign');
    try {
      guardDeveloperChanges(input, loadProjectConfig(repo, true)!, directory, base);
      expect.fail('foreign paths accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(ChangeZonesExceededError);
      expect(
        JSON.parse(
          (error as ChangeZonesExceededError).diagnostic().slice('Developer failed: '.length),
        ),
      ).toEqual({ category: 'change_zones_exceeded', paths: [...foreign].sort() });
    }
    const error = new ChangeZonesExceededError(['server/__tests__/evil\n\u001b.test.ts']);
    expect(error.diagnostic()).not.toContain('\n');
    expect(error.diagnostic()).not.toContain('\u001b');
  });
  it('matches literal zones, directories and zero or more globstar directories', () => {
    expect(matchesChangeZone('src/a.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesChangeZone('src/nested/a.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesChangeZone('src/a.ts', 'src/*.ts')).toBe(true);
    expect(matchesChangeZone('src/nested/a.ts', 'src/*.ts')).toBe(false);
    expect(matchesChangeZone('src/a.ts', 'src')).toBe(false);
    expect(matchesChangeZone('src/a.ts', 'src/', true)).toBe(true);
    expect(matchesChangeZone('outside/a.ts', 'src/**')).toBe(false);
  });

  it('rejects a concrete protected descendant inside an otherwise valid directory zone', () => {
    fs.mkdirSync(path.join(repo, 'webview-ui/test'), { recursive: true });
    const zone = 'webview-ui/test';
    const config = loadProjectConfig(repo, true)!;
    config.operator.protectedPaths = ['**/.codex/**'];
    expect(() => validateChangeZone(repo, zone, config.operator.protectedPaths!)).not.toThrow();
    const base = git(repo, 'rev-parse', 'HEAD');
    const directory = detachedTree();
    const relative = 'webview-ui/test/.codex/x';
    expect(matchesChangeZone(relative, zone, true)).toBe(true);
    fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
    fs.writeFileSync(path.join(directory, relative), 'protected instructions');
    git(directory, 'add', '.');
    const input = { task: { changeZones: [zone] } } as DeveloperRequest;
    expect(() => guardDeveloperChanges(input, config, directory, base)).toThrow('forbidden path');
    const gate = guardProtectedPaths({
      cwd: directory,
      base,
      staged: true,
      operator: config.operator,
      projectId: 'test',
    });
    expect(gate.paths).toEqual([relative]);
    expect(gate.decision.outcome).not.toBe('allow');
    expect(git(directory, 'rev-parse', 'HEAD')).toBe(base);
  });

  it('requires actual test additions and rejects staged-only or deleted evidence', () => {
    fs.mkdirSync(path.join(repo, 'server/__tests__'), { recursive: true });
    const relative = 'server/__tests__/audit.test.ts';
    const original = "it('baseline', () => {});\n";
    fs.writeFileSync(path.join(repo, relative), original);
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'baseline test');
    const base = git(repo, 'rev-parse', 'HEAD');
    const guardTree = path.join(root, 'guard-tree');
    git(repo, 'worktree', 'add', '--detach', guardTree, 'main');
    const file = path.join(guardTree, relative);
    const input = { task: { changeZones: ['server/src/audit*.ts'] } } as DeveloperRequest;
    const check = () =>
      guardDeveloperChanges(input, loadProjectConfig(repo, true)!, guardTree, base);
    fs.appendFileSync(file, "it('acceptance', () => {});\n");
    expect(check).toThrow('requires an assertion');
    fs.writeFileSync(file, original + "it('acceptance', () => expect(true).toBe(true));\n");
    expect(check()).toEqual([relative]);
    git(guardTree, 'add', '.');
    fs.writeFileSync(file, original);
    expect(check).toThrow('requires an added or adjusted');
    fs.unlinkSync(file);
    expect(check).toThrow('requires an added or adjusted');
  });

  it.each(['delete', 'empty', 'disguised'])('rejects %s of a foreign test suite', (mode) => {
    const relative = 'server/__tests__/foreign.test.ts';
    fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
    fs.writeFileSync(path.join(repo, relative), "it('foreign', () => expect(true).toBe(true));\n");
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'foreign suite');
    const base = git(repo, 'rev-parse', 'HEAD');
    const directory = detachedTree();
    if (mode === 'delete') fs.unlinkSync(path.join(directory, relative));
    else
      fs.writeFileSync(
        path.join(directory, relative),
        mode === 'empty' ? '' : 'export const logic = 1;',
      );
    const input = { task: { changeZones: ['server/src/audit*.ts'] } } as DeveloperRequest;
    expect(() =>
      guardDeveloperChanges(input, loadProjectConfig(repo, true)!, directory, base),
    ).toThrow('changeZones exceeded');
  });

  it('allows explicit testZones, while suffixes alone grant no scope', () => {
    const base = git(repo, 'rev-parse', 'HEAD');
    const directory = detachedTree();
    const relative = 'integration/audit.test.ts';
    fs.mkdirSync(path.join(directory, 'integration'));
    fs.writeFileSync(
      path.join(directory, relative),
      "it('acceptance', () => expect(true).toBe(true));\n",
    );
    const input = { task: { changeZones: ['server/src/audit.ts'] } } as DeveloperRequest;
    const check = () =>
      guardDeveloperChanges(input, loadProjectConfig(repo, true)!, directory, base);
    expect(check).toThrow('changeZones exceeded');
    input.task.testZones = ['integration/audit.test.ts'];
    expect(check()).toEqual([relative]);
  });

  it.each([
    "it('empty', () => {});",
    "describe.skip('skipped', () => { it('test', () => expect(true).toBe(true)); });",
    "it.todo('later');",
    "it.only('focused', () => expect(true).toBe(true));",
    "it['skip']('skipped', () => expect(true).toBe(true));",
    "it('skipped', { skip: true }, () => expect(true).toBe(true));",
    "it.skipIf(true)('skipped', () => expect(true).toBe(true));",
  ])('rejects invalid test additions: %s', (source) => {
    const base = git(repo, 'rev-parse', 'HEAD');
    const directory = detachedTree();
    fs.mkdirSync(path.join(directory, 'server/__tests__'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'server/__tests__/audit.test.ts'), source);
    const input = { task: { changeZones: ['server/src/audit.ts'] } } as DeveloperRequest;
    expect(() =>
      guardDeveloperChanges(input, loadProjectConfig(repo, true)!, directory, base),
    ).toThrow(/assertion|skip\/todo\/only/);
  });

  it.each(
    ['empty', 'skipped', 'partial-skip', 'missing', 'passed', 'failed'].flatMap((mode) =>
      ['server/__tests__', 'webview-ui/test', ...(mode === 'passed' ? ['server/src'] : [])].map(
        (zone) => ({ mode, zone }),
      ),
    ),
  )('requires Developer execution evidence per file: $zone $mode', async ({ mode, zone }) => {
    const base = git(repo, 'rev-parse', 'HEAD');
    const directory = detachedTree();
    fs.mkdirSync(path.join(directory, zone), { recursive: true });
    const relative = zone + '/audit.test.ts';
    fs.writeFileSync(
      path.join(directory, relative),
      `import { it, expect, describe } from 'vitest';\n${
        mode === 'empty'
          ? "describe('empty', () => {});"
          : `it${mode === 'skipped' ? '.skip' : ''}('evidence', () => { expect(process.cwd()).toBe(${JSON.stringify(path.join(directory, zone.split('/')[0]))}); expect(true).toBe(${mode !== 'failed'}); });`
      }`,
    );
    if (mode === 'partial-skip')
      fs.appendFileSync(
        path.join(directory, relative),
        "it.skip('omitted', () => expect(true).toBe(true));",
      );
    const failures: VerifierFailure[] = [];
    const verification = checkCascadeCriteria(
      { commands: [] },
      base,
      directory,
      root,
      new AbortController().signal,
      undefined,
      mode === 'missing' ? [relative, 'server/__tests__/missing.test.ts'] : [relative],
      base,
      { failures },
    );
    // Missing/skipped execution provides no assertion evidence. It must stop the
    // run as infrastructure, without consuming another Developer attempt.
    if (['empty', 'skipped', 'partial-skip', 'missing'].includes(mode)) {
      await expect(verification).rejects.toBeInstanceOf(VerifierInfrastructureError);
      await expect(verification).rejects.toThrow('Vitest missing, skipped or incomplete tests');
      return;
    }
    const result = await verification;
    expect(result).toEqual([mode === 'passed' ? 'pass' : 'fail']);
    if (mode === 'failed') {
      expect(failures[0]).toMatchObject({ verifier: 'tests', files: [relative], result: 'fail' });
      expect(failures[0].detail).toContain('expected');
    }
  });

  it.each([true, false])(
    'runs related tests separately for both workspaces (webview passes=%s)',
    async (pass) => {
      const directory = detachedTree();
      for (const workspace of ['server', 'webview-ui']) {
        const testDir = workspace === 'server' ? '__tests__' : 'test';
        fs.mkdirSync(path.join(directory, workspace, testDir), { recursive: true });
        fs.writeFileSync(
          path.join(directory, workspace, 'answer.ts'),
          'export const answer = false;',
        );
        fs.writeFileSync(
          path.join(directory, workspace, testDir, 'answer.test.ts'),
          `
import { it, expect } from 'vitest'; import { answer } from '../answer';
it('related workspace', () => {
  expect(process.cwd()).toBe(${JSON.stringify(path.join(directory, workspace))});
  expect(answer).toBe(${workspace === 'server' || pass});
});`,
        );
      }
      git(directory, 'add', '.');
      git(directory, 'commit', '-m', 'related fixture');
      const base = git(directory, 'rev-parse', 'HEAD');
      for (const workspace of ['server', 'webview-ui'])
        fs.writeFileSync(
          path.join(directory, workspace, 'answer.ts'),
          'export const answer = true;',
        );
      expect(
        await checkCascadeCriteria(
          { commands: [{ vitestRelated: true, timeoutMs: 10_000 }] },
          base,
          directory,
          root,
          new AbortController().signal,
        ),
      ).toEqual([pass ? 'pass' : 'fail']);
      expect(fs.existsSync(path.join(directory, 'node_modules'))).toBe(false);
    },
  );

  it.each([false, true])(
    'rejects unknown roots in Developer/cascade (related=%s)',
    async (related) => {
      const base = git(repo, 'rev-parse', 'HEAD');
      const directory = detachedTree();
      fs.mkdirSync(path.join(directory, 'integration'));
      fs.writeFileSync(
        path.join(directory, related ? 'integration/audit.ts' : 'integration/audit.test.ts'),
        "it('outside', () => expect(true).toBe(true));",
      );
      await expect(
        checkCascadeCriteria(
          { commands: related ? [{ vitestRelated: true, timeoutMs: 5000 }] : [] },
          base,
          directory,
          root,
          new AbortController().signal,
          undefined,
          related ? undefined : ['integration/audit.test.ts'],
        ),
      ).rejects.toThrow(/Unsupported Vitest .*root/);
      expect(fs.existsSync(path.join(directory, 'node_modules'))).toBe(false);
    },
  );

  it('rejects preseeded branches without a trusted base, including outside commits', async () => {
    const branch = `sa/${task}-developer`;
    git(repo, 'checkout', '-b', branch);
    fs.writeFileSync(path.join(repo, 'outside.txt'), 'hidden outside changes');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'outside');
    git(repo, 'checkout', 'main');
    const manager = new WorktreeManager({
      repositoryPath: repo,
      defaultBranch: 'main',
      manualPreparation: true,
      trustedBase: true,
    });
    await expect(manager.create(task, 'developer')).rejects.toThrow('no registered trusted base');
    expect(fs.existsSync(tree())).toBe(false);
  });

  it('persists a trusted base and checks it on every retry', async () => {
    const manager = new WorktreeManager({
      repositoryPath: repo,
      defaultBranch: 'main',
      manualPreparation: true,
      trustedBase: true,
    });
    const base = git(repo, 'rev-parse', 'HEAD');
    expect((await manager.create(task, 'developer')).base).toBe(base);
    expect((await manager.create(task, 'developer')).base).toBe(base);
    fs.writeFileSync(path.join(repo, 'outside.txt'), 'new main');
    git(repo, 'add', 'outside.txt');
    git(repo, 'commit', '-m', 'main advanced');
    expect(taskBranchBase(repo, `sa/${task}-developer`, 'main')).toBe(base);
    git(tree(), 'reset', '--hard', 'main');
    await expect(manager.create(task, 'developer')).rejects.toThrow('merge-base differs');
  });
});

describe.skipIf(process.platform !== 'win32')('Developer via worker (fake CLI)', () => {
  it.each([false, true])(
    'regenerates stale bindings before verification (broken=%s)',
    async (broken) => {
      fs.mkdirSync(path.join(repo, 'core/src'), { recursive: true });
      fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'core/asyncapi.yaml'), 'title: original\n');
      fs.writeFileSync(
        path.join(repo, 'core/src/messages.ts'),
        'export const generated = false;\n',
      );
      fs.writeFileSync(
        path.join(repo, 'scripts/generate-messages.ts'),
        broken
          ? "throw new Error('exact generator failure: invalid FeatureCost');\n"
          : "import fs from 'node:fs'; fs.writeFileSync('core/src/messages.ts', 'export const generated = true;\\n');\n",
      );
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'generator fixture');
      await prepare(true, true, 'generated');
      if (broken) {
        await expect(develop('generated')).rejects.toThrow(
          'exact generator failure: invalid FeatureCost',
        );
        expect(git(tree(), 'show', 'HEAD:core/src/messages.ts')).toContain('false');
      } else {
        await develop('generated');
        expect(git(tree(), 'show', 'HEAD:core/src/messages.ts')).toContain('true');
        const store = await storeFor();
        try {
          expect(store.getTask(task)).toMatchObject({ status: 'REVIEW', attempt: 0 });
        } finally {
          store.close();
        }
        expect(
          new AuditLog()
            .read('test')
            .some((row) => !row.corrupt && row.entry.outcome.status === 'generated_autofix'),
        ).toBe(true);
      }
      expect(fs.readFileSync(launches, 'utf8').trim().split('\n')).toHaveLength(1);
    },
  );

  it('does not launch the contract generator for an unrelated diff', async () => {
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'scripts/generate-messages.ts'),
      "throw new Error('must not run');\n",
    );
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'broken unused generator');
    await prepare();
    await develop();
    expect(fs.readFileSync(launches, 'utf8').trim().split('\n')).toHaveLength(1);
  });
  it('retains attempt budget across repeated agent-reported environment blockers with exit zero', async () => {
    await prepare();
    enableGuardCascade();
    for (let retry = 0; retry < 2; retry++) {
      await expect(develop('environment-blocked')).rejects.toThrow(
        'Verifier infrastructure: agent reported an environment blocker',
      );
      const store = await storeFor();
      try {
        expect(store.getTask(task)).toMatchObject({ status: 'FAILED_RETRYABLE', attempt: 0 });
      } finally {
        store.close();
      }
    }
    expect(fs.readFileSync(launches, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(cascadeAttempts()).toHaveLength(2);
    expect(
      cascadeAttempts().every((a) => a.result === 'infrastructure_error' && a.tier === 'economy'),
    ).toBe(true);
  });
  it.each(['qa-author', 'test-author'])(
    'routes %s through the Developer lifecycle, review and QA without changing its declaration',
    async (designMode) => {
      await prepare(true, true, designMode);
      await develop('valid', false);
      const store = await storeFor();
      try {
        const record = store.getTask(task)!;
        expect(record.status).toBe('REVIEW');
        expect(record.agent_role).toBe(designMode === 'test-author' ? 'test' : 'qa');
        expect(
          store
            .listExecutions()
            .filter((e) => e.task_key === task)
            .at(-1)?.agent_role,
        ).toBe('qa-author');
        const launch = JSON.parse(fs.readFileSync(launches, 'utf8').trim());
        expect(launch.args.join(' ')).toContain('Role: qa-author');
        expect(git(tree(), 'diff', '--name-only', record.review_ref!.base)).not.toContain(
          'server/src/',
        );
        const executions = store.listExecutions().length;
        await develop();
        expect(store.listExecutions()).toHaveLength(executions);
        await run(['review', 'FEAT-001', '--task', task], 'reviewer', 'approve');
        expect(store.getTask(task)?.status).toBe('QA');
        await run(['qa', 'FEAT-001', '--task', task], 'qa');
        expect(store.getTask(task)?.status).toBe('DONE');
        expect(store.getTask(task)?.test_reports?.at(-1)?.report.commands).toEqual([
          {
            command: 'vitest:server/__tests__/audit.test.ts',
            result: 'pass',
            passed: 1,
            failed: 0,
          },
        ]);
      } finally {
        store.close();
      }
    },
  );

  it('rejects product edits by QA author even inside a declared broad changeZone', async () => {
    await prepare(true, true, 'qa-author');
    const base = git(repo, 'rev-parse', 'main');
    await expect(develop('product')).rejects.toThrow('changeZones exceeded');
    const store = await storeFor();
    try {
      expect(lastDeveloperFailure(store, store.getTask(task)!)).toMatchObject({
        category: 'change_zones_exceeded',
        paths: ['server/src/audit.ts'],
      });
      expect(store.getTask(task)?.review_ref).toBeNull();
      expect(git(tree(), 'rev-parse', 'HEAD')).toBe(base);
    } finally {
      store.close();
    }
  });

  it.each(['valid', 'qa-author'])(
    'categorizes missing_test for %s, exposes it and supplies it on explicit retry',
    async (designMode) => {
      await prepare(true, true, designMode);
      await expect(develop('no-test')).rejects.toThrow('requires an added or adjusted');
      const store = await storeFor();
      try {
        expect(lastDeveloperFailure(store, store.getTask(task)!)).toMatchObject({
          category: 'missing_test',
          paths: [],
        });
        await develop();
        const launch = JSON.parse(fs.readFileSync(launches, 'utf8').trim().split('\n').at(-1)!);
        expect(JSON.parse(launch.context.task.brief).previousFailure.category).toBe('missing_test');
        expect(store.getTask(task)?.status).toBe('REVIEW');
      } finally {
        store.close();
      }
    },
  );

  it.each(
    ['valid', 'qa-author'].flatMap((designMode) =>
      ['bad-lint', 'bad-test'].map((mode) => ({ designMode, mode })),
    ),
  )('fails $mode in $designMode before registering review', async ({ designMode, mode }) => {
    await prepare(true, true, designMode);
    const base = git(repo, 'rev-parse', 'main');
    await expect(develop(mode)).rejects.toThrow('verifier failed');
    const store = await storeFor();
    try {
      expect(store.getTask(task)?.review_ref).toBeNull();
      expect(git(tree(), 'rev-parse', 'HEAD')).toBe(base);
      expect(store.getTask(task)?.blocked_reason).toContain(
        `verifier_failed: ${mode === 'bad-lint' ? 'eslint' : 'tests'}`,
      );
      if (mode === 'bad-lint') {
        const launchesData = fs
          .readFileSync(launches, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(launchesData).toHaveLength(2);
        expect(launchesData[1].context.task.verifierFailures[0].detail).toContain('no-debugger');
      }
    } finally {
      store.close();
    }
  });

  it.each(
    ['valid', 'qa-author'].flatMap((designMode) =>
      ['bad-format', 'bad-imports'].map((mode) => ({ designMode, mode })),
    ),
  )(
    'commits automatic $mode fixes in $designMode without another model attempt',
    async ({ designMode, mode }) => {
      await prepare(true, true, designMode);
      await develop(mode);
      const lines = fs.readFileSync(launches, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(git(tree(), 'show', 'HEAD:server/__tests__/audit.test.ts')).toContain(
        mode === 'bad-format' ? 'const brokenFormat = 1;' : "import { expect, it } from 'vitest';",
      );
    },
  );

  it('keeps unavailable e2e execution as not_tested in QA with its runtime reason', async () => {
    await prepare(true, true, 'qa-author-e2e');
    // Developer has evidence; QA later observes an unavailable environment independently.
    vi.spyOn(taskTests, 'runTaskTest').mockResolvedValueOnce({
      result: 'pass',
      passed: 1,
      failed: 0,
    });
    await develop();
    await run(['review', 'FEAT-001', '--task', task], 'reviewer', 'approve');
    await run(['qa', 'FEAT-001', '--task', task], 'qa');
    const store = await storeFor();
    try {
      expect(store.getTask(task)?.status).toBe('QA');
      const report = store.getTask(task)?.test_reports?.at(-1)?.report;
      expect(report?.verdict).toBe('not_tested');
      expect(report?.commands[0]).toMatchObject({
        command: 'playwright:e2e/tests/standalone/audit.spec.ts',
        result: 'not_tested',
        passed: 0,
        failed: 0,
        reason: expect.any(String),
      });
      expect(report?.acceptance[0]).toMatchObject({
        status: 'not_tested',
        evidence: expect.stringContaining(report!.commands[0].reason!),
      });
    } finally {
      store.close();
    }
  });
  it('retries failed rework from its last valid commit, preserving review findings and the original base', async () => {
    await prepare();
    await develop();
    const head = git(tree(), 'rev-parse', 'HEAD');
    await run(['review', 'FEAT-001', '--task', task], 'reviewer', 'reject');
    await expect(develop('outside')).rejects.toThrow('changeZones exceeded');
    const store = await storeFor();
    try {
      const before = store.getTask(task)!;
      expect(before.attempt).toBe(1);
      expect(git(tree(), 'rev-parse', 'HEAD')).toBe(head);
      await develop();
      expect(store.getTask(task)).toMatchObject({
        status: 'REVIEW',
        attempt: 1,
        review_ref: { base: git(repo, 'rev-parse', 'main') },
      });
      expect(git(tree(), 'rev-parse', 'HEAD^')).toBe(head);
      const launch = JSON.parse(fs.readFileSync(launches, 'utf8').trim().split('\n').at(-1)!);
      expect(JSON.parse(launch.context.task.brief)).toMatchObject({
        reworkAttempt: 1,
        reviewFindings: [{ summary: 'Missing pagination' }],
        previousFailure: { category: 'change_zones_exceeded' },
      });
    } finally {
      store.close();
    }
  });

  it.each(['feature', 'design', 'dependencies'])(
    'revalidates %s before discarding a failed attempt',
    async (mode) => {
      await prepare();
      await expect(develop('outside')).rejects.toThrow('changeZones exceeded');
      const store = await storeFor();
      try {
        if (mode === 'dependencies') store.addTaskDependency(task, 'FEAT-001-T02');
        else {
          const relative =
            mode === 'feature' ? 'features/FEAT-001.yaml' : 'technical-designs/FEAT-001.md';
          fs.appendFileSync(
            path.join(repo, '.worktrees/FEAT-001/.softwareagents/brain', relative),
            '\nchanged',
          );
        }
        const executions = store.listExecutions();
        await expect(develop()).rejects.toThrow(/SHA|declaration/);
        expect(store.getTask(task)).toMatchObject({ status: 'FAILED_RETRYABLE', attempt: 0 });
        expect(store.listExecutions()).toEqual(executions);
        expect(fs.existsSync(path.join(tree(), 'outside.txt'))).toBe(true);
      } finally {
        store.close();
      }
    },
  );

  it('records scope failures and retries only explicitly, discarding dirty edits without following junctions', async () => {
    await prepare();
    const base = git(repo, 'rev-parse', 'main');
    await expect(develop('outside')).rejects.toThrow('changeZones exceeded');
    const store = await storeFor();
    try {
      const failed = store.getTask(task)!;
      expect(failed.status).toBe('FAILED_RETRYABLE');
      const paths = ['outside.txt', 'server/__tests__/foreign.test.ts'];
      expect(JSON.parse(failed.blocked_reason!.slice('Developer failed: '.length))).toEqual({
        category: 'change_zones_exceeded',
        paths,
      });
      expect(
        new AuditLog()
          .read('test')
          .some((row) => !row.corrupt && row.entry.outcome.reason === failed.blocked_reason),
      ).toBe(true);
      for (const args of [
        ['show', 'FEAT-001'],
        ['show', 'FEAT-001', '--json'],
      ]) {
        const log = vi.fn();
        await runFeatureCommand(args, repo, log);
        expect(log.mock.calls[0][0]).toContain('change_zones_exceeded');
        expect(log.mock.calls[0][0]).toContain('server/__tests__/foreign.test.ts');
      }
      const log = vi.fn();
      await runTaskCommand(['list', '--json'], repo, log);
      expect(
        JSON.parse(log.mock.calls[0][0]).find((t: { key: string }) => t.key === task)
          .last_developer_failure,
      ).toMatchObject({ category: 'change_zones_exceeded', paths });
      await expect(develop('valid', false)).rejects.toThrow('eligible READY');
      // Initial result plus its free correction share the same logical attempt.
      expect(store.listExecutions().filter((e) => e.task_key === task)).toHaveLength(2);
      expect(fs.existsSync(path.join(tree(), 'outside.txt'))).toBe(true);
      // Both a nested link and node_modules point outside the tree; their targets must survive.
      const target = path.join(root, 'link-target');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'sentinel'), 'preserve');
      for (const link of ['node_modules', 'server/linked'])
        fs.symlinkSync(target, path.join(tree(), link), 'junction');
      git(tree(), 'add', 'outside.txt');
      fs.mkdirSync(path.join(tree(), 'ignored-retry'));
      fs.writeFileSync(path.join(tree(), 'ignored-retry/junk'), 'discard');
      fs.appendFileSync(path.join(repo, '.git/info/exclude'), '\nignored-retry/\n');
      await develop();
      const retried = store.getTask(task)!;
      expect(retried).toMatchObject({
        status: 'REVIEW',
        attempt: failed.attempt,
        branch: failed.branch,
        worktree_ref: failed.worktree_ref,
        review_ref: { base },
      });
      expect(fs.readFileSync(path.join(target, 'sentinel'), 'utf8')).toBe('preserve');
      for (const discarded of [...paths, 'node_modules', 'server/linked', 'ignored-retry'])
        expect(fs.existsSync(path.join(tree(), discarded))).toBe(false);
      expect(git(tree(), 'status', '--porcelain')).toBe('');
      expect(taskBranchBase(repo, retried.branch!, 'main')).toBe(base);
      const launch = JSON.parse(fs.readFileSync(launches, 'utf8').trim().split('\n').at(-1)!);
      expect(launch.context.kind).toBe('untrusted-context-data');
      const context = JSON.parse(launch.context.task.brief);
      expect(context.previousFailure).toMatchObject({ category: 'change_zones_exceeded', paths });
      for (const command of [runTaskCommand, runFeatureCommand]) {
        const output = vi.fn();
        await command(
          command === runTaskCommand ? ['list', '--json'] : ['show', 'FEAT-001', '--json'],
          repo,
          output,
        );
        const data = JSON.parse(output.mock.calls[0][0]);
        expect(
          (Array.isArray(data) ? data : data.tasks).find((t: { key: string }) => t.key === task)
            .last_developer_failure,
        ).toBeNull();
      }
      expect(
        store.listDomainEvents(task).some((event) => event.reason === failed.blocked_reason),
      ).toBe(true);
      expect(context.allowedScope).toMatchObject({
        changeZones: ['server/src/audit*.ts'],
        testZones: [],
        mirroredTestZones: ['server/__tests__/audit*.test.ts'],
      });
    } finally {
      store.close();
    }
  });

  it('preserves the concrete verifier infrastructure cause without consuming agent attempts', async () => {
    await prepare();
    enableGuardCascade();
    vi.spyOn(taskTests, 'runTaskTest').mockResolvedValueOnce({
      result: 'not_tested',
      passed: 0,
      failed: 0,
      reason: 'Verifier infrastructure: synthetic server build failed in scratch',
    });
    await expect(develop()).rejects.toThrow('synthetic server build failed in scratch');
    expect(cascadeAttempts()).toEqual([
      expect.objectContaining({ result: 'infrastructure_error', tier: 'economy' }),
    ]);
    const store = await storeFor();
    try {
      expect(store.getTask(task)).toMatchObject({
        status: 'FAILED_RETRYABLE',
        attempt: 0,
        blocked_reason: 'Verifier infrastructure: synthetic server build failed in scratch',
      });
      expect(
        new AuditLog().read('test').flatMap((row) => (row.corrupt ? [] : [row.entry.outcome])),
      ).toContainEqual(
        expect.objectContaining({
          status: 'cascade_attempt',
          cascade: expect.objectContaining({
            result: 'infrastructure_error',
            reason: store.getTask(task)!.blocked_reason,
          }),
        }),
      );
    } finally {
      store.close();
    }
  });

  it('gates workspace infrastructure failures before launching the Developer', async () => {
    await prepare();
    vi.spyOn(WorktreeManager.prototype, 'create').mockRejectedValueOnce(
      new Error('synthetic Git worktree preparation unavailable'),
    );
    await expect(develop()).rejects.toThrow('synthetic Git worktree preparation unavailable');
    const store = await storeFor();
    try {
      expect(store.getTask(task)).toMatchObject({
        status: 'WAITING_HUMAN',
        attempt: 0,
        lease_owner: null,
      });
      expect(store.getTask(task)?.blocked_reason).toContain(
        'category=workspace; exit_code=unknown',
      );
      expect(store.getTask(task)?.blocked_reason).toContain(
        'synthetic Git worktree preparation unavailable',
      );
      expect(lastDeveloperFailure(store, store.getTask(task)!)?.reason).toBe(
        store.getTask(task)?.blocked_reason,
      );
      expect(fs.readFileSync(launches, 'utf8')).toBe('');
    } finally {
      store.close();
    }
  });

  it('gates repeated scope violations with the exact cause instead of exhausting attempts', async () => {
    await prepare();
    const store = await storeFor();
    try {
      for (let i = 0; i < 2; i++)
        await expect(develop('outside')).rejects.toThrow('changeZones exceeded');
      expect(store.getTask(task)).toMatchObject({
        status: 'WAITING_HUMAN',
        attempt: 0,
        review_ref: null,
        lease_owner: null,
      });
      expect(lastDeveloperFailure(store, store.getTask(task)!)).toMatchObject({
        category: 'change_zones_exceeded',
        gate: 'repeated_guard; human review required',
      });
      expect(store.getTask(task)!.blocked_reason).toContain('outside.txt');
      // Attempt + its single free correction, then one paid attempt (no second correction).
      expect(store.listExecutions().filter((e) => e.task_key === task)).toHaveLength(3);
      await expect(develop()).rejects.toThrow('No eligible');
      expect(store.listExecutions().filter((e) => e.task_key === task)).toHaveLength(3);
    } finally {
      store.close();
    }
  });

  it('bounds alternating guard violations and allows a fresh cycle after an operator reset', async () => {
    await prepare();
    for (const mode of ['outside', 'no-test', 'outside'])
      await expect(develop(mode)).rejects.toThrow();
    const store = await storeFor();
    try {
      const record = store.getTask(task)!;
      expect(record).toMatchObject({ status: 'WAITING_HUMAN', attempt: 0 });
      await store.transition(
        task,
        record.version,
        'READY',
        'Operator reset after inspection',
        'operator',
      );
      // Simulate the operator repairing the rejected tree; READY is an explicit new cycle.
      for (const file of [
        'outside.txt',
        'server/__tests__/foreign.test.ts',
        'server/src/audit.ts',
        'server/__tests__/audit.test.ts',
      ])
        fs.unlinkSync(path.join(tree(), file));
      await expect(develop('outside')).rejects.toThrow('changeZones exceeded');
      expect(store.getTask(task)?.status).toBe('FAILED_RETRYABLE');
    } finally {
      store.close();
    }
  });

  it.each(['claude', 'codex'] as const)(
    'preserves exit 0 and core scope diagnostics through audit, task and retry (%s)',
    async (selected) => {
      configure(undefined, selected);
      await prepare(true, true, 'core');
      const file = path.join(root, '.pixel-agents/config.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      config.projects.test.modelTiers = {
        rule: parse(
          fs.readFileSync(
            path.resolve(__dirname, '../../.softwareagents/agents/model-policy.yaml'),
            'utf8',
          ),
        ).tierRule,
        maxTier: 'economy',
        tiers: {
          economy: {
            candidates: [
              { executor: selected, model: selected === 'claude' ? 'haiku' : 'gpt-5.4-mini' },
            ],
          },
        },
        cascade: {
          enabled: true,
          startTier: 'economy',
          maxEscalations: 0,
          verifiers: {},
          defaultVerifier: { commands: [{ vitestRelated: true, timeoutMs: 30_000 }] },
        },
      };
      fs.writeFileSync(file, JSON.stringify(config));
      await expect(develop('core-outside')).rejects.toThrow('changeZones exceeded');
      const store = await storeFor();
      try {
        const failure = lastDeveloperFailure(store, store.getTask(task)!);
        expect(failure).toMatchObject({
          category: 'change_zones_exceeded',
          paths: ['core/src/messages.test.ts'],
        });
        const audit = new AuditLog()
          .read('test')
          .filter((row) => !row.corrupt && row.entry.outcome.status === 'cascade_attempt');
        expect(audit).toHaveLength(1);
        expect(audit[0].corrupt ? undefined : audit[0].entry.outcome.cascade).toMatchObject({
          result: 'guard_rejected',
          exitCode: 0,
          verifiers: [],
          reason: failure!.reason,
        });
        const attempts = () =>
          fs
            .readFileSync(path.join(repo, '.git/softwareagents/cascade-attempts.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        expect(attempts()[0]).toMatchObject({
          result: 'guard_rejected',
          exitCode: 0,
          reason: failure!.reason,
        });
        await develop('core-valid');
        expect(store.getTask(task)?.status).toBe('REVIEW');
        const context = JSON.parse(
          JSON.parse(fs.readFileSync(launches, 'utf8').trim().split('\n').at(-1)!).context.task
            .brief,
        );
        expect(context.previousFailure).toMatchObject({
          category: 'change_zones_exceeded',
          paths: ['core/src/messages.test.ts'],
        });
        expect(context.allowedScope).toMatchObject({
          testZones: [],
          mirroredTestZones: ['server/__tests__/core/messages*.test.ts'],
        });
        expect(context.allowedScope.coreTestRule).toContain('Never place tests in core/src/');
        expect(context.allowedScope.fileWriteRule).toContain('never through shell writes');
        expect(context.allowedScope.testTempRule).toContain('os.tmpdir()');
        expect(context.allowedScope.colocatedTestRule).toContain('never next to sources');
        expect(attempts().at(-1)).toMatchObject({ result: 'pass', exitCode: 0 });
        expect(
          attempts()
            .at(-1)
            .verifiers.every((result: string) => result === 'pass'),
        ).toBe(true);
      } finally {
        store.close();
      }
    },
  );
  it.each(['claude', 'codex'] as const)(
    'commits one eligible task via %s, records review_ref and retries without duplicate executions',
    async (selected) => {
      configure(undefined, selected);
      await prepare();
      const remote = path.join(root, 'remote.git');
      git(root, 'init', '--bare', remote);
      git(repo, 'remote', 'add', 'origin', remote);
      const main = git(repo, 'rev-parse', 'main');
      await develop('valid', false);
      const store = await storeFor();
      try {
        const record = store.getTask(task)!;
        expect(record.status).toBe('REVIEW');
        expect(record.review_ref).toMatchObject({
          branch: `sa/${task}-developer`,
          sha: git(tree(), 'rev-parse', 'HEAD'),
          base: main,
        });
        expect(git(tree(), 'log', '-1', '--format=%B')).toContain('SoftwareAgents-Execution:');
        expect(git(repo, 'rev-parse', 'main')).toBe(main);
        expect(store.getTask('FEAT-001-T02')?.status).toBe('DRAFT');
        const before = store.listExecutions();
        await develop();
        await develop('valid', false);
        expect(store.listExecutions()).toEqual(before);
        expect(git(tree(), 'rev-parse', 'HEAD')).toBe(record.review_ref!.sha);
        const log = vi.fn();
        await runFeatureCommand(['show', 'FEAT-001', '--json'], repo, log);
        expect(
          JSON.parse(log.mock.calls[0][0]).tasks.find((t: { key: string }) => t.key === task)
            .review_ref,
        ).toEqual(record.review_ref);
        const launch = JSON.parse(fs.readFileSync(launches, 'utf8').trim());
        const data = JSON.parse(launch.context.task.brief);
        expect(data.approvedSpec.acceptance[0].id).toBe('AC-001');
        expect(data.task.changeZones).toEqual(['server/src/audit*.ts']);
        expect(data.design).toContain('Technical design');
        expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe('');
        if (selected === 'codex')
          expect(launch.args[launch.args.indexOf('--sandbox') + 1]).toBe('workspace-write');
      } finally {
        store.close();
      }
    },
  );
  it('skips READY tasks with unfinished dependencies and develops only the first eligible code task', async () => {
    await prepare(true, true, 'developer-dependency');
    const store = await storeFor();
    try {
      expect(store.getTask(task)?.status).toBe('DRAFT');
      const record = store.getTask(task)!;
      await store.transition(task, record.version, 'READY', 'fixture', 'test');
      await expect(develop()).rejects.toThrow(/eligible READY/);
      await develop('valid', false);
      expect(store.getTask(task)?.status).toBe('READY');
      expect(store.getTask('FEAT-001-T02')?.status).toBe('REVIEW');
      expect(
        store
          .listExecutions()
          .filter((e) => e.agent_template_version && e.task_key.startsWith('FEAT-001-T')),
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  });
  it.each(['READY', 'FAILED_RETRYABLE'])(
    'blocks a %s launch whose actual branch HEAD misses a DONE dependency',
    async (status) => {
      await prepare(true, true, 'developer-dependency');
      const base = git(repo, 'rev-parse', 'main');
      await new WorktreeManager({
        repositoryPath: repo,
        defaultBranch: 'main',
        manualPreparation: true,
        trustedBase: true,
      }).create(task, 'developer');
      const sha = git(
        repo,
        'commit-tree',
        `${base}^{tree}`,
        '-p',
        base,
        '-m',
        'dependency fixture',
      );
      const branch = 'sa/FEAT-001-T02-developer';
      git(repo, 'branch', branch, sha);
      const db = new DatabaseSync(path.join(repo, '.git/softwareagents/work.sqlite3'));
      db.prepare("UPDATE tasks SET status = 'DONE', review_ref = ? WHERE key = 'FEAT-001-T02'").run(
        JSON.stringify({ branch, sha, base }),
      );
      db.prepare('UPDATE tasks SET status = ? WHERE key = ?').run(status, task);
      db.close();
      const store = await storeFor();
      try {
        if (status === 'FAILED_RETRYABLE') {
          // Match a prior attempt's durable worktree association, with no review_ref.
          const db = new DatabaseSync(path.join(repo, '.git/softwareagents/work.sqlite3'));
          db.prepare('UPDATE tasks SET branch = ?, worktree_ref = ? WHERE key = ?').run(
            `sa/${task}-developer`,
            tree(),
            task,
          );
          db.close();
        }
        await expect(develop()).rejects.toThrow(/Dependency FEAT-001-T02.*launch HEAD/);
        expect(fs.readFileSync(launches, 'utf8')).toBe('');
        expect(git(tree(), 'rev-parse', 'HEAD')).toBe(base);
        expect(store.getTask(task)?.review_ref).toBeNull();
      } finally {
        store.close();
      }
    },
  );
  it.each(['outside', 'no-test', 'bad-test', 'empty-test', 'unexecuted-assertion', 'skip-suite'])(
    'rejects %s without committing',
    async (mode) => {
      await prepare();
      const main = git(repo, 'rev-parse', 'main');
      await expect(develop(mode)).rejects.toThrow(/changeZones|test|verifier/i);
      expect(git(tree(), 'rev-parse', 'HEAD')).toBe(main);
      const store = await storeFor();
      try {
        expect(store.getTask(task)?.review_ref).toBeNull();
      } finally {
        store.close();
      }
    },
  );
  it('reevaluates WAITING_QUOTA through lifecycle recovery', async () => {
    await prepare();
    const store = await storeFor();
    try {
      let record = store.getTask(task)!;
      await store.transition(task, record.version, 'WAITING_QUOTA', 'quota wait', 'test');
      await develop();
      record = store.getTask(task)!;
      expect(record.status).toBe('REVIEW');
      expect(record.review_ref?.base).toBe(git(repo, 'rev-parse', 'main'));
    } finally {
      store.close();
    }
  });
  it.each(['unapproved', 'missing-design', 'changed-design', 'blocked-task'])(
    'rejects %s before launching',
    async (mode) => {
      await prepare(mode !== 'unapproved', mode !== 'missing-design');
      if (mode === 'changed-design')
        fs.appendFileSync(
          path.join(
            repo,
            '.worktrees/FEAT-001/.softwareagents/brain/technical-designs/FEAT-001.md',
          ),
          '\nchanged',
        );
      if (mode === 'blocked-task') {
        const store = await storeFor();
        try {
          const t = store.getTask(task)!;
          await store.transition(task, t.version, 'BLOCKED', 'test', 'test');
        } finally {
          store.close();
        }
      }
      await expect(develop()).rejects.toThrow(/approved|design|SHA|eligible|READY/i);
      expect(fs.readFileSync(launches, 'utf8')).toBe('');
    },
  );
  it('pushes only the task ref to an explicit resolved URL, once, when enabled', async () => {
    await prepare();
    const remote = path.join(root, 'remote.git');
    git(root, 'init', '--bare', remote);
    // Even a remote named main cannot become the destination branch.
    git(repo, 'remote', 'add', 'main', remote);
    configure({ enabled: true, remote: 'main' });
    await develop();
    await develop();
    expect(git(remote, 'rev-parse', `refs/heads/sa/${task}-developer`)).toBe(
      git(tree(), 'rev-parse', 'HEAD'),
    );
    expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe(
      `refs/heads/sa/${task}-developer`,
    );
    const store = await storeFor();
    try {
      expect(store.listExecutions().filter((e) => e.task_key === task)).toHaveLength(1);
      const review = store.getTask(task)!.review_ref!;
      await expect(
        pushDeveloperBranch(store, loadProjectConfig(repo, true)!, task, {
          ...review,
          branch: 'main',
        }),
      ).rejects.toThrow('push_main = deny');
      expect(git(repo, 'rev-parse', 'main')).toBe(review.base);
      git(repo, 'remote', 'add', 'broken', path.join(root, 'missing.git'));
      const config = loadProjectConfig(repo, true)!;
      config.operator.developer!.pushBranch.remote = 'broken';
      await expect(pushDeveloperBranch(store, config, task, review)).rejects.toThrow(
        'local review_ref retained',
      );
      await expect(pushDeveloperBranch(store, config, task, review)).rejects.toThrow(
        'pending or uncertain',
      );
      expect(store.getTask(task)?.review_ref).toEqual(review);
    } finally {
      store.close();
    }
  });
});
