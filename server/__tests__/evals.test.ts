import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { AuditLog } from '../src/auditLog.js';
import { parseEvalArgs, runEvalCommand } from '../src/evalCommand.js';
import * as evalCriteria from '../src/evalCriteria.js';
import { checkEvalCriteria } from '../src/evalCriteria.js';
import { assertEvalRunAllowed } from '../src/evalGuard.js';
import { assertEvalIntegrity, evalChangedFiles } from '../src/evalIntegrity.js';
import {
  buildEvalReport,
  evalResultsDirectory,
  parseEvalRecord,
  readEvalRecords,
} from '../src/evalReport.js';
import * as evalTasks from '../src/evalTasks.js';
import { evalGit, type EvalTask, loadEvalTasks, parseEvalTask } from '../src/evalTasks.js';
import { EXECUTOR_PROBE_CATALOG } from '../src/executorProbes.js';
import { readExecutorSlots } from '../src/executorSlots.js';
import { checkCascadeCriteria } from '../src/modelCascade.js';
import { loadWorkerAgentSpec } from '../src/worker.js';
import { readyProbeFor } from './helpers/readyProbe.js';

vi.setConfig({ testTimeout: 30_000 });

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: () => process.env.HOME ?? actual.homedir() };
});
vi.mock('../src/constants.js', async (original) => ({
  ...(await original<typeof import('../src/constants.js')>()),
  EVAL_CRITERION_TIMEOUT_MS: 5_000,
}));

const sourceRoot = path.resolve(__dirname, '../..');
const fake = path.join(__dirname, 'fixtures/fake-eval-cli.cjs');
const ready = readyProbeFor(EXECUTOR_PROBE_CATALOG);
let root: string;
let repo: string;
let task: EvalTask;
let configFile: string;
let launches: string;
let initialConfig: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  for (const [key, value] of Object.entries({
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, 'codex'),
    GIT_AUTHOR_NAME: 'Test',
    GIT_COMMITTER_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'empty-gitconfig'),
    SA_TEST_TELEMETRY: '1',
    SA_EVAL_FAKE_LOG: path.join(root, 'launches.jsonl'),
  }))
    vi.stubEnv(key, value);
  for (const key of [
    'CI',
    'SA_MANAGED_EXECUTION',
    'SA_AUTOPILOT',
    'SA_WORKER',
    'CLAUDECODE',
    'SA_EVAL_FAKE_MODE',
  ])
    vi.stubEnv(key, undefined);
  launches = process.env.SA_EVAL_FAKE_LOG!;
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL!, '');
  evalGit(repo, ['init', '-b', 'main']);
  fs.mkdirSync(path.join(repo, '.softwareagents/evals'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.softwareagents/project.yaml'),
    'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: test\nname: Test\nrepo:\n  remote: https://example.invalid/test.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n',
  );
  fs.mkdirSync(path.join(repo, 'scripts'));
  fs.copyFileSync(
    path.join(sourceRoot, 'scripts/remove-worktree.ps1'),
    path.join(repo, 'scripts/remove-worktree.ps1'),
  );
  fs.mkdirSync(path.join(repo, 'server/__tests__'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'server/poison.ts'), 'export {};');
  fs.writeFileSync(path.join(repo, 'answer.txt'), 'broken');
  evalGit(repo, ['add', '.']);
  evalGit(repo, ['commit', '-m', 'base']);
  const baseCommit = evalGit(repo, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repo, 'answer.txt'), 'fixed');
  fs.writeFileSync(
    path.join(repo, 'server/__tests__/answer.test.ts'),
    "import '../poison.js'; import { it, expect } from 'vitest'; import { readFileSync } from 'fs'; import { resolve } from 'path';\nit('repairs answer', () => expect(readFileSync(resolve(import.meta.dirname, '../../answer.txt'), 'utf8')).toBe('fixed'));\n",
  );
  evalGit(repo, ['add', '.']);
  evalGit(repo, ['commit', '-m', 'fix']);
  task = {
    version: 1,
    id: 'answer',
    baseCommit,
    fixCommit: evalGit(repo, ['rev-parse', 'HEAD']),
    brief: 'PROMPT_SECRET_MARKER: repair answer.txt',
    timeoutMin: 1,
    allowedPaths: ['answer.txt'],
    criteria: [{ file: 'server/__tests__/answer.test.ts', testName: 'repairs answer' }],
  };
  fs.writeFileSync(path.join(repo, '.softwareagents/evals/answer.json'), JSON.stringify(task));
  configFile = path.join(root, '.pixel-agents/config.json');
  fs.mkdirSync(path.dirname(configFile));
  const rule = parse(
    fs.readFileSync(path.join(sourceRoot, '.softwareagents/agents/model-policy.yaml'), 'utf8'),
  ).tierRule;
  initialConfig = JSON.stringify({
    projects: {
      test: {
        autonomyLevel: 'A1',
        allowedExecutors: ['claude', 'codex'],
        binaryPaths: { claude: process.execPath, codex: process.execPath },
        quotaThresholds: { claude: 0, codex: 0 },
        concurrency: { maxExecutions: 1, perExecutor: { claude: 1, codex: 1 } },
        modelTiers: {
          maxTier: 'standard',
          rule,
          tiers: {
            economy: {
              candidates: [
                { executor: 'claude', model: 'claude-test' },
                { executor: 'codex', model: 'gpt-test', effort: 'low' },
              ],
            },
            standard: {
              candidates: [
                { executor: 'claude', model: 'claude-test' },
                { executor: 'codex', model: 'gpt-test' },
              ],
              fallbackTo: 'economy',
            },
          },
        },
        telemetry: {
          prices: {
            'claude-test': { input: 1, output: 2, cacheRead: 0.1, cacheCreate: 1.25 },
            'gpt-test': { input: 1, output: 2, cacheRead: 0.1 },
          },
        },
      },
    },
  });
  fs.writeFileSync(configFile, initialConfig);
});
afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // Every eval tree was cleaned through the safe removal script. Never traverse a junction.
  expect(
    fs.existsSync(path.join(repo, '.worktrees'))
      ? fs.readdirSync(path.join(repo, '.worktrees'))
      : [],
  ).toEqual([]);
  fs.rmSync(root, { recursive: true, force: true });
});
const readRecords = () => readEvalRecords(evalResultsDirectory(path.join(repo, '.git'), 'test'));

function detachCascadeMetadata() {
  fs.unlinkSync(path.join(repo, '.softwareagents/evals/answer.json'));
  const metadata = path.join(root, 'metadata');
  fs.renameSync(path.join(repo, '.git'), metadata);
  fs.writeFileSync(path.join(repo, '.git'), `gitdir: ${metadata.replace(/\\/g, '/')}\n`);
}

describe('default cascade integrity and related tests', () => {
  it.each(['new', 'modified', 'staged-only', 'deleted'])(
    'rejects a %s gitlink even without submodule metadata on disk',
    async (kind) => {
      let base = task.fixCommit;
      if (kind !== 'new') {
        evalGit(repo, ['update-index', '--add', '--cacheinfo', `160000,${task.baseCommit},module`]);
        evalGit(repo, ['commit', '-m', 'gitlink fixture']);
        base = evalGit(repo, ['rev-parse', 'HEAD']);
      }
      detachCascadeMetadata();
      if (kind === 'deleted') evalGit(repo, ['update-index', '--force-remove', 'module']);
      else
        evalGit(repo, ['update-index', '--add', '--cacheinfo', `160000,${task.fixCommit},module`]);
      if (kind === 'staged-only') {
        fs.mkdirSync(path.join(repo, 'module'));
        fs.writeFileSync(path.join(repo, 'module/source.ts'), 'export {};');
        // The directory masks the staged gitlink change in the worktree diff.
      }
      const command = vi.spyOn(evalCriteria, 'runVerifierCommand').mockResolvedValue('pass');
      for (const allowedPaths of [undefined, ['module', 'module/source.ts']]) {
        expect(() => assertEvalIntegrity({ baseCommit: base, allowedPaths }, repo)).toThrow(
          'criteria_tampered: Eval changed a Git submodule',
        );
        await expect(
          checkCascadeCriteria(
            { allowedPaths, commands: [{ vitestRelated: true, timeoutMs: 5000 }] },
            base,
            repo,
            root,
            new AbortController().signal,
          ),
        ).rejects.toThrow('criteria_tampered');
      }
      expect(command).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(repo, 'node_modules'))).toBe(false);
    },
  );

  it.each(['server/__tests__/guard.test.ts', 'operator-private/guard.ts'])(
    'rejects edits inside an existing submodule protecting %s',
    async (protectedFile) => {
      const module = path.join(repo, 'module');
      fs.mkdirSync(path.dirname(path.join(module, protectedFile)), { recursive: true });
      evalGit(module, ['init', '-b', 'main']);
      fs.writeFileSync(path.join(module, protectedFile), 'original');
      evalGit(module, ['add', '.']);
      evalGit(module, ['commit', '-m', 'protected submodule fixture']);
      const commit = evalGit(module, ['rev-parse', 'HEAD']);
      const metadata = path.join(root, 'module-metadata');
      fs.renameSync(path.join(module, '.git'), metadata);
      fs.writeFileSync(path.join(module, '.git'), `gitdir: ${metadata.replace(/\\/g, '/')}\n`);
      evalGit(repo, ['update-index', '--add', '--cacheinfo', `160000,${commit},module`]);
      evalGit(repo, ['commit', '-m', 'submodule fixture']);
      const base = evalGit(repo, ['rev-parse', 'HEAD']);
      detachCascadeMetadata();
      fs.writeFileSync(path.join(module, protectedFile), 'tampered');
      const command = vi.spyOn(evalCriteria, 'runVerifierCommand').mockResolvedValue('pass');
      const protectedPaths = [`module/${protectedFile}`];
      for (const allowedPaths of [undefined, ['module']]) {
        // Covers evals and custom/default cascade bindings through their shared guard.
        expect(() =>
          assertEvalIntegrity({ baseCommit: base, allowedPaths, protectedPaths }, repo),
        ).toThrow('criteria_tampered');
        await expect(
          checkCascadeCriteria(
            { allowedPaths, commands: [{ vitestRelated: true, timeoutMs: 5000 }] },
            base,
            repo,
            root,
            new AbortController().signal,
            protectedPaths,
          ),
        ).rejects.toThrow('criteria_tampered');
      }
      expect(command).not.toHaveBeenCalled();
      // Even a clean submodule is rejected because nested Git metadata is opaque.
      fs.writeFileSync(path.join(module, protectedFile), 'original');
      expect(() => assertEvalIntegrity({ baseCommit: base }, repo)).toThrow('nested .git');
    },
  );

  it.each(['file', 'directory'])('rejects nested .git metadata (%s)', (kind) => {
    detachCascadeMetadata();
    const nested = path.join(repo, 'server/.git');
    if (kind === 'file') fs.writeFileSync(nested, 'gitdir: elsewhere\n');
    else fs.mkdirSync(nested);
    expect(() => assertEvalIntegrity({ baseCommit: task.fixCommit }, repo)).toThrow(
      'criteria_tampered',
    );
  });

  it.each(['..\\..\\outside.ts', 'ordinary\\source.ts'])(
    'rejects a POSIX changed name with backslashes before constructing argv: %s',
    async (file) => {
      detachCascadeMetadata();
      // Git can return these literal names on POSIX; inject them on Windows too.
      const actualGit = evalGit;
      vi.spyOn(evalTasks, 'evalGit').mockImplementation((cwd, args) =>
        args[0] === 'ls-files' && args.includes('--others') ? `${file}\0` : actualGit(cwd, args),
      );
      const command = vi.spyOn(evalCriteria, 'runVerifierCommand').mockResolvedValue('pass');
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
      try {
        Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' });
        await expect(
          checkCascadeCriteria(
            { commands: [{ vitestRelated: true, timeoutMs: 5000 }] },
            task.fixCommit,
            repo,
            root,
            new AbortController().signal,
          ),
        ).rejects.toThrow('criteria_tampered');
      } finally {
        Object.defineProperty(process, 'platform', descriptor);
      }
      expect(command).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(repo, 'node_modules'))).toBe(false);
    },
  );

  it('checks containment of normalized related arguments before launching Vitest', async () => {
    detachCascadeMetadata();
    const actualGit = evalGit;
    vi.spyOn(evalTasks, 'evalGit').mockImplementation((cwd, args) =>
      args[0] === 'ls-files' && args.includes('--others')
        ? '../outside.ts\0'
        : actualGit(cwd, args),
    );
    const command = vi.spyOn(evalCriteria, 'runVerifierCommand').mockResolvedValue('pass');
    await expect(
      checkCascadeCriteria(
        { commands: [{ vitestRelated: true, timeoutMs: 5000 }] },
        task.fixCommit,
        repo,
        root,
        new AbortController().signal,
      ),
    ).rejects.toThrow('criteria_tampered: Related test path escaped');
    expect(command).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(repo, 'node_modules'))).toBe(false);
  });

  it('passes only normalized, contained absolute filenames in the final related argv', async () => {
    detachCascadeMetadata();
    const files = [' leading.ts', '--config.mjs', 'server/deleted.ts', 'ordinary.jsx'];
    fs.writeFileSync(path.join(repo, 'server/deleted.ts'), 'export {};');
    evalGit(repo, ['add', 'server/deleted.ts']);
    evalGit(repo, ['commit', '-m', 'deleted source fixture']);
    const base = evalGit(repo, ['rev-parse', 'HEAD']);
    fs.unlinkSync(path.join(repo, 'server/deleted.ts'));
    for (const file of files.filter((file) => file !== 'server/deleted.ts'))
      fs.writeFileSync(path.join(repo, file), 'export {};');
    const command = vi.spyOn(evalCriteria, 'runVerifierCommand').mockResolvedValue('pass');
    expect(
      await checkCascadeCriteria(
        { commands: [{ vitestRelated: true, timeoutMs: 5000 }] },
        base,
        repo,
        root,
        new AbortController().signal,
      ),
    ).toEqual(['pass']);
    const argv = command.mock.calls[0][0];
    const related = argv.slice(argv.indexOf('native') + 1);
    expect(related).toHaveLength(files.length);
    expect([...related].sort()).toEqual(
      files.map((file) => path.resolve(repo, file).replace(/\\/g, '/')).sort(),
    );
    for (const file of related) {
      expect(file).toBe(path.posix.normalize(file));
      expect(path.posix.relative(repo.replace(/\\/g, '/'), file)).not.toMatch(/^\.\.(?:\/|$)/);
    }
  });

  it('derives exact changed paths from tracked, staged, deleted, untracked and ignored files', () => {
    for (const file of [' leading.ts', 'staged.cjs', 'deleted.mjs'])
      fs.writeFileSync(path.join(repo, file), 'export {};');
    evalGit(repo, ['add', ' leading.ts', 'staged.cjs', 'deleted.mjs']);
    evalGit(repo, ['commit', '-m', 'source fixtures']);
    const base = evalGit(repo, ['rev-parse', 'HEAD']);
    detachCascadeMetadata();
    fs.writeFileSync(path.join(repo, ' leading.ts'), 'export const changed = true;');
    fs.writeFileSync(path.join(repo, 'staged.cjs'), 'module.exports = true;');
    evalGit(repo, ['add', 'staged.cjs']);
    // A staged-only edit must still count after the worktree content is restored.
    fs.writeFileSync(path.join(repo, 'staged.cjs'), 'export {};');
    fs.unlinkSync(path.join(repo, 'deleted.mjs'));
    fs.writeFileSync(path.join(repo, '--config.mjs'), 'export {};');
    fs.writeFileSync(path.join(root, 'metadata/info/exclude'), 'ignored.jsx\n');
    fs.writeFileSync(path.join(repo, 'ignored.jsx'), 'export {};');
    expect(evalChangedFiles(repo, base).sort()).toEqual(
      [' leading.ts', 'staged.cjs', 'deleted.mjs', '--config.mjs', 'ignored.jsx'].sort(),
    );
  });

  it.each([
    'server/__tests__/answer.test.ts',
    'server/foo.spec.ts',
    'tests/helper.ts',
    'vitest.config.ts',
    'server/tsconfig.json',
    '.eslintrc.json',
    'eslint.config.js',
    'server/package.json',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb',
    '.softwareagents/brain/task.md',
    '.github/workflows/ci.yml',
    '.codex/config.toml',
    'nested/AGENTS.md',
    'scripts/check.js',
    'operator-private/file.ts',
  ])('rejects %s before the default command can execute', async (file) => {
    detachCascadeMetadata();
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), 'changed');
    const marker = path.join(root, 'executed');
    await expect(
      checkCascadeCriteria(
        {
          commands: [
            {
              argv: [
                process.execPath,
                '-e',
                `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`,
              ],
              timeoutMs: 5000,
            },
          ],
        },
        task.fixCommit,
        repo,
        root,
        new AbortController().signal,
        ['operator-private/**'],
      ),
    ).rejects.toThrow('criteria_tampered');
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(repo, 'node_modules'))).toBe(false);
  });

  it('allows ordinary source files but rejects links without an allowedPaths ceiling', () => {
    detachCascadeMetadata();
    fs.writeFileSync(path.join(repo, 'server/clock.ts'), 'export {};');
    expect(() => assertEvalIntegrity({ baseCommit: task.fixCommit }, repo)).not.toThrow();
    const link = path.join(repo, 'linked');
    fs.symlinkSync(
      path.join(repo, 'server'),
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    try {
      expect(() => assertEvalIntegrity({ baseCommit: task.fixCommit }, repo)).toThrow(
        'criteria_tampered',
      );
    } finally {
      fs.unlinkSync(link);
    }
  });

  it('runs only tests related to changed TS/JS files with an isolated home', async () => {
    const marker = path.join(root, 'related-ran');
    fs.appendFileSync(
      path.join(repo, 'server/__tests__/answer.test.ts'),
      `
import os from 'os'; import { writeFileSync } from 'fs';
it('isolates related tests', () => {
  expect(os.homedir()).toBe(process.env.HOME);
  writeFileSync(${JSON.stringify(marker)}, 'ran');
});\n`,
    );
    fs.writeFileSync(
      path.join(repo, 'server/__tests__/unrelated.test.ts'),
      "import { it } from 'vitest'; it('must not run', () => { throw new Error('unrelated'); });",
    );
    evalGit(repo, ['add', 'server/__tests__']);
    evalGit(repo, ['commit', '-m', 'related test fixtures']);
    const base = evalGit(repo, ['rev-parse', 'HEAD']);
    detachCascadeMetadata();
    fs.writeFileSync(path.join(repo, 'server/poison.ts'), 'export const changed = true;');
    fs.writeFileSync(path.join(repo, 'unrelated.md'), 'also changed');
    expect(
      await checkCascadeCriteria(
        { commands: [{ vitestRelated: true, timeoutMs: 5000 }] },
        base,
        repo,
        root,
        new AbortController().signal,
      ),
    ).toEqual(['pass']);
    expect(fs.readFileSync(marker, 'utf8')).toBe('ran');
    expect(fs.existsSync(path.join(repo, 'node_modules'))).toBe(false);
  }, 20000);
});

it('audits and retains the cause when standard requires auth after economy fails', async () => {
  const raw = JSON.parse(initialConfig);
  const policy = raw.projects.test.modelTiers;
  policy.tiers.economy.candidates = [{ executor: 'claude', model: 'test-economy' }];
  policy.tiers.standard.candidates = [{ executor: 'codex', model: 'test-standard' }];
  policy.cascade = {
    enabled: true,
    startTier: 'economy',
    maxEscalations: 1,
    verifiers: {
      answer: {
        allowedPaths: ['answer.txt'],
        commands: [
          {
            argv: [process.execPath, '-e', 'process.exitCode = 1'],
            timeoutMs: 5000,
          },
        ],
      },
    },
  };
  fs.writeFileSync(configFile, JSON.stringify(raw));
  vi.stubEnv('SA_EVAL_FAKE_MODE', 'cascade');
  const log = vi.fn();
  await runEvalCommand(
    ['run', '--task', 'answer', '--cascade', '--repeat', '1', '--yes', '--json'],
    {
      cwd: repo,
      log,
      worker: {
        binaryArgs: [fake, 'claude'],
        probe: (file, args) =>
          args[0] === 'login' && args[1] === 'status'
            ? Promise.resolve({ code: 1, output: 'Not logged in' })
            : ready(file, args),
      },
    },
  );
  const cause = {
    code: 'auth_required',
    tier: 'standard',
    executor: 'codex',
    reason: expect.stringContaining('auth_required'),
    exclusions: [{ executor: 'codex', tier: 'standard', code: 'auth_required' }],
  };
  const result = JSON.parse(log.mock.calls[0][0]);
  expect(result.results[0]).toMatchObject({ status: 'blocked', blockedCause: cause });
  expect(result.results[0].cascade.attempts).toHaveLength(1);
  expect((await readRecords()).records[0].blockedCause).toEqual(cause);
  expect(result.configurations[0].blockedCauses).toEqual([{ task: 'answer', ...cause }]);
  const audit = new AuditLog()
    .read('test')
    .filter((r) => !r.corrupt && r.entry.outcome.status === 'availability_blocked');
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ entry: { outcome: { blockedCause: cause } } });
  const report = vi.fn();
  await runEvalCommand(['report'], { cwd: repo, log: report });
  expect(report.mock.calls[0][0]).toContain('standard/codex auth_required');
  expect(fs.readFileSync(launches, 'utf8').trim().split('\n')).toHaveLength(1);
  expect(readExecutorSlots('claude').count).toBe(0);
  expect(readExecutorSlots('codex').count).toBe(0);
  expect(process.exitCode).toBe(3);
});

it.each(['task', 'default'])(
  'evaluates %s cascades as one configuration and sums all attempts at captured prices',
  async (binding) => {
    const raw = JSON.parse(initialConfig);
    const policy = raw.projects.test.modelTiers;
    policy.tiers.economy.candidates = [{ executor: 'claude', model: 'test-economy' }];
    policy.tiers.standard.candidates = [{ executor: 'claude', model: 'test-standard' }];
    policy.cascade = {
      enabled: true,
      startTier: 'economy',
      maxEscalations: 2,
      verifiers: {
        answer: {
          allowedPaths: ['answer.txt'],
          commands: [
            {
              argv: [
                process.execPath,
                '-e',
                "process.exitCode = require('fs').readFileSync('answer.txt','utf8') === 'fixed' ? 0 : 1",
              ],
              timeoutMs: 5000,
            },
          ],
        },
      },
    };
    if (binding === 'default') {
      policy.cascade.defaultVerifier = { commands: policy.cascade.verifiers.answer.commands };
      policy.cascade.verifiers = {};
    }
    fs.writeFileSync(configFile, JSON.stringify(raw));
    vi.stubEnv('SA_EVAL_FAKE_MODE', 'cascade');
    const log = vi.fn();
    await runEvalCommand(
      ['run', '--task', 'answer', '--cascade', '--repeat', '1', '--yes', '--json'],
      {
        cwd: repo,
        log,
        worker: { binaryArgs: [fake, 'claude'], probe: ready },
      },
    );
    const result = JSON.parse(log.mock.calls[0][0]);
    expect(result.results[0].status).toBe('success');
    expect(result.results[0].cascade.attempts).toHaveLength(2);
    expect(result.configurations).toHaveLength(1);
    const configuration = result.configurations[0];
    expect(configuration.tier).toBe('cascade');
    expect(configuration.totals.executions).toBe(2);
    expect(configuration.totals.inputTokens).toBe(32);
    expect(configuration.costPerSolvedTaskUsd).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('PROMPT_SECRET_MARKER');
    const records = (await readRecords()).records;
    // A later admission block still spent the quota of both earlier attempts.
    const blocked = parseEvalRecord({ ...records[0], status: 'blocked', repetition: 2 });
    const report = buildEvalReport([...records, blocked]);
    expect(report.configurations[0].totals.executions).toBe(4);
    expect(report.configurations[0].costPerSolvedTaskUsd).toBeCloseTo(
      configuration.costPerSolvedTaskUsd * 2,
    );
    const fixed = parseEvalRecord({ ...records[0], cascade: undefined, repetition: 3 });
    expect(buildEvalReport([...records, fixed]).configurations).toHaveLength(2);
    expect(() =>
      parseEvalArgs(['run', '--task', 'answer', '--cascade', '--tier', 'economy', '--repeat', '1']),
    ).toThrow();
  },
  20000,
);

// Exercise only pinned local verifiers; no Executor is launched by this helper.
async function verifyFixture(code: string, names = ['isolates criterion']) {
  fs.writeFileSync(path.join(repo, task.criteria[0].file), code);
  evalGit(repo, ['add', '.']);
  evalGit(repo, ['commit', '-m', 'verifier fixture']);
  const verifier = {
    ...task,
    fixCommit: evalGit(repo, ['rev-parse', 'HEAD']),
    criteria: names.map((testName) => ({ file: task.criteria[0].file, testName })),
  };
  const scratch = path.join(root, 'verify');
  fs.mkdirSync(scratch);
  try {
    return await checkEvalCriteria(verifier, repo, repo, scratch);
  } finally {
    const link = path.join(repo, 'node_modules');
    if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(link);
  }
}

describe('verifier isolation and integrity', () => {
  it('excludes seeded credentials, CI and Node flags and uses a fresh home for every criterion', async () => {
    const secrets = [
      'CLICKUP_TOKEN',
      'PIXEL_AGENTS_TOKEN',
      'GH_TOKEN',
      'CUSTOM_API_KEY',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'UNLISTED_SECRET',
      'CI',
    ];
    for (const key of secrets) vi.stubEnv(key, 'seeded-parent-secret');
    // Would prevent the child from starting if inherited.
    vi.stubEnv('NODE_OPTIONS', '--invalid-parent-node-option');
    const code = `import { it, expect } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
for (const name of ['isolates criterion', 'isolates second criterion']) it(name, () => {
  for (const key of ${JSON.stringify(secrets)}) expect(process.env[key]).toBeUndefined();
  expect(process.env.NODE_OPTIONS).toBe('');
  expect(process.env.HOME).not.toBe(${JSON.stringify(root)});
  expect(os.homedir()).toBe(process.env.HOME);
  for (const key of ['USERPROFILE', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA'])
    expect(process.env[key]).toBe(process.env.HOME);
  const marker = path.join(os.homedir(), 'marker');
  expect(fs.existsSync(marker)).toBe(false); fs.writeFileSync(marker, 'owned');
});`;
    expect(await verifyFixture(code, ['isolates criterion', 'isolates second criterion'])).toEqual([
      true,
      true,
    ]);
    expect(fs.readdirSync(path.join(root, 'verify'))).toEqual([]);
    expect(fs.existsSync(path.join(root, 'marker'))).toBe(false);
  }, 20_000);

  it.skipIf(process.env.SA_SKIP_TASKKILL_TEST === '1')(
    'kills a hung criterion and its child process',
    async () => {
      const pids = path.join(root, 'pids.json');
      const code = `import { spawn } from 'child_process'; import { writeFileSync } from 'fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));
while (true) { /* Deliberately blocks Vitest's own timers. */ }`;
      let verified = false;
      try {
        expect(await verifyFixture(code)).toEqual([false]);
        const children: number[] = JSON.parse(fs.readFileSync(pids, 'utf8'));
        for (const pid of children)
          await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2000 });
        expect(fs.readdirSync(path.join(root, 'verify'))).toEqual([]);
        verified = true;
      } finally {
        // Test-only fallback: never leave a fixture alive if the platform denies taskkill.
        if (!verified && fs.existsSync(pids)) {
          const children: number[] = JSON.parse(fs.readFileSync(pids, 'utf8'));
          for (const pid of children) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              /* Already closed. */
            }
          }
        }
      }
    },
    20_000,
  );

  it('bounds criterion output and cleans its temporary home', async () => {
    expect(await verifyFixture(`process.stdout.write('x'.repeat(2 * 1024 * 1024));`)).toEqual([
      false,
    ]);
    expect(fs.readdirSync(path.join(root, 'verify'))).toEqual([]);
  }, 20_000);

  it.each([
    'untracked',
    'ignored',
    'staged',
    'tracked',
    'head',
    'link',
    'config',
    'assume-unchanged',
    'skip-worktree',
  ])('fails closed for %s changes outside the allowlist', (kind) => {
    // Integrity requires a detached base checkout, just as the real eval runner does.
    evalGit(repo, ['checkout', '--detach', task.baseCommit]);
    fs.unlinkSync(path.join(repo, '.softwareagents/evals/answer.json'));
    expect(() => assertEvalIntegrity(task, repo)).toThrow('Git directory');
    // A test-only copy of the Git directory outside the tree models worktree metadata.
    const metadata = path.join(root, 'metadata');
    fs.renameSync(path.join(repo, '.git'), metadata);
    fs.writeFileSync(path.join(repo, '.git'), `gitdir: ${metadata.replace(/\\/g, '/')}\n`);
    expect(() => assertEvalIntegrity(task, repo)).not.toThrow();
    if (kind === 'head') evalGit(repo, ['checkout', '--detach', task.fixCommit]);
    else if (kind === 'link')
      fs.symlinkSync(
        path.join(repo, 'server'),
        path.join(repo, 'linked'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    else {
      const file = ['tracked', 'assume-unchanged', 'skip-worktree'].includes(kind)
        ? 'server/poison.ts'
        : kind === 'config'
          ? 'package.json'
          : 'forbidden.ts';
      if (kind === 'assume-unchanged' || kind === 'skip-worktree')
        evalGit(repo, ['update-index', `--${kind}`, file]);
      fs.writeFileSync(path.join(repo, file), 'changed');
      if (kind === 'ignored')
        fs.writeFileSync(path.join(metadata, 'info/exclude'), 'forbidden.ts\n');
      if (kind === 'staged') {
        evalGit(repo, ['add', file]);
        fs.unlinkSync(path.join(repo, file));
      }
    }
    try {
      expect(() => assertEvalIntegrity(task, repo)).toThrow();
    } finally {
      const link = path.join(repo, 'linked');
      if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(link);
    }
  });
});

async function run(executor: 'claude' | 'codex', extra: string[] = []) {
  const output: string[] = [];
  await runEvalCommand(
    [
      'run',
      '--task',
      'answer',
      '--executor',
      executor,
      '--tier',
      'economy',
      '--repeat',
      '1',
      '--yes',
      '--json',
      ...extra,
    ],
    {
      cwd: repo,
      log: (line) => output.push(line),
      worker: { binaryArgs: [fake, executor], probe: ready },
    },
  );
  return JSON.parse(output[0]);
}

describe('eval task declarations and no-launch commands', () => {
  it('validates all five real historical tasks without launching or writing results', async () => {
    const tasks = loadEvalTasks(sourceRoot);
    expect(tasks).toHaveLength(5);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(5);
    const probe = vi.fn(ready);
    for (const command of ['list', 'validate', 'report']) {
      const log = vi.fn();
      await runEvalCommand([command, '--json'], { cwd: repo, log, worker: { probe } });
      expect(JSON.parse(log.mock.calls[0][0])).toBeDefined();
    }
    expect(probe).not.toHaveBeenCalled();
    expect(fs.existsSync(launches)).toBe(false);
    expect(fs.existsSync(path.join(repo, '.git/softwareagents'))).toBe(false);
  });
  it('rejects unknown/nested fields, malformed refs, path traversal and wrong ancestry', () => {
    for (const change of [
      { authority: true },
      { id: 'all' },
      { baseCommit: 'HEAD' },
      { timeoutMin: 100 },
      { criteria: [{ ...task.criteria[0], command: 'anything' }] },
      { criteria: [{ file: '../../escape.test.ts', testName: '.' }] },
      { criteria: [{ ...task.criteria[0], testName: '[' }] },
      { allowedPaths: undefined },
      { allowedPaths: [] },
      { allowedPaths: ['answer.txt', 'answer.txt'] },
      ...[
        '../answer.txt',
        '/answer.txt',
        'server/**',
        'server\\answer.ts',
        './answer.txt',
        'server/__tests__/answer.test.ts',
        'server/unit.spec.ts',
        'server/tests/helper.ts',
        'vitest.config.ts',
        'server/package-lock.json',
        'server/node_modules/evil.ts',
      ].map((file) => ({ allowedPaths: [file] })),
    ])
      expect(() => parseEvalTask({ ...task, ...change })).toThrow();
    fs.writeFileSync(
      path.join(repo, '.softwareagents/evals/answer.json'),
      JSON.stringify({ ...task, baseCommit: task.fixCommit }),
    );
    expect(() => loadEvalTasks(repo)).toThrow('parent');
  });
  it('requires unique, explicit run flags and a bounded positive repetition count', () => {
    const valid = [
      'run',
      '--task',
      'all',
      '--executor',
      'codex',
      '--tier',
      'economy',
      '--repeat',
      '2',
    ];
    expect(parseEvalArgs(valid)).toMatchObject({ repeat: 2, yes: false });
    for (const argv of [
      [],
      ['run'],
      [...valid, '--repeat', '1'],
      [...valid, '--unknown'],
      valid.map((s) => (s === '2' ? '0' : s)),
      valid.map((s) => (s === '2' ? '21' : s)),
      ['report', '--yes'],
    ])
      expect(() => parseEvalArgs(argv)).toThrow();
  });
});

describe('operator-only quota guard', () => {
  it.each(['CI', 'SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])(
    'refuses %s even with --yes before prompting or launching',
    async (key) => {
      vi.stubEnv(key, 'false');
      const confirm = vi.fn();
      const probe = vi.fn(ready);
      await expect(
        runEvalCommand(
          [
            'run',
            '--task',
            'answer',
            '--executor',
            'codex',
            '--tier',
            'economy',
            '--repeat',
            '1',
            '--yes',
          ],
          { cwd: repo, confirm, worker: { probe } },
        ),
      ).rejects.toThrow(/forbidden|operator-only/);
      expect(confirm).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
      expect(fs.existsSync(launches)).toBe(false);
      expect(fs.existsSync(path.join(repo, '.git/softwareagents'))).toBe(false);
    },
  );
  it('treats even empty CI as defined', () =>
    expect(() => assertEvalRunAllowed({ CI: '' })).toThrow());
  it('prompts with the actual number of runs and cancellation launches nothing', async () => {
    const confirm = vi.fn(async () => false);
    await expect(
      runEvalCommand(
        ['run', '--task', 'all', '--executor', 'codex', '--tier', 'economy', '--repeat', '3'],
        { cwd: repo, confirm },
      ),
    ).rejects.toThrow('cancelled');
    expect(confirm).toHaveBeenCalledWith(3);
    expect(fs.existsSync(path.join(repo, '.git/softwareagents'))).toBe(false);
  });
  it.each(['disabled', 'level', 'maxTier', 'catalog'])(
    'respects Operator %s restrictions without changing config or probing',
    async (kind) => {
      const config = JSON.parse(initialConfig);
      const operator = config.projects.test;
      if (kind === 'disabled') operator.allowedExecutors = ['claude'];
      if (kind === 'level') operator.executorLevels = { codex: [] };
      if (kind === 'maxTier') {
        operator.modelTiers.maxTier = 'economy';
        delete operator.modelTiers.tiers.economy;
      }
      if (kind === 'catalog') delete operator.modelTiers;
      const contents = JSON.stringify(config);
      fs.writeFileSync(configFile, contents);
      await expect(run('codex')).rejects.toThrow();
      expect(fs.readFileSync(configFile, 'utf8')).toBe(contents);
      expect(fs.existsSync(launches)).toBe(false);
    },
  );
  it('maxExecutions=0 blocks in worker admission, launches nothing and cleans the tree', async () => {
    const config = JSON.parse(initialConfig);
    config.projects.test.concurrency.maxExecutions = 0;
    fs.writeFileSync(configFile, JSON.stringify(config));
    const result = await run('codex');
    expect(result.results[0].status).toBe('blocked');
    expect(fs.existsSync(launches)).toBe(false);
    expect(result.configurations[0]).toMatchObject({ attempts: 0, blocked: 1 });
  });
});

describe('worker-backed evals with fake CLIs', () => {
  it.each(['claude', 'codex'] as const)(
    '%s succeeds in a detached base tree and persists only metrics',
    async (executor) => {
      const before = evalGit(repo, ['rev-parse', 'HEAD']);
      const result = await run(executor);
      expect(result.results[0]).toMatchObject({
        status: 'success',
        repetition: 1,
        criteria: [true],
      });
      expect(result.configurations[0]).toMatchObject({
        successRate: 1,
        consistency: 'unknown',
        pareto: true,
      });
      expect(result.configurations[0].totals.inputTokens).toBe(executor === 'codex' ? 10 : 16);
      expect(result.configurations[0].totals.cacheReadTokens).toBe(4);
      expect(result.configurations[0].totals.outputTokens).toBe(5);
      expect(result.configurations[0].costPerSolvedTaskUsd).toBeGreaterThan(0);
      expect(readExecutorSlots('claude').count).toBe(0);
      expect(readExecutorSlots('codex').count).toBe(0);
      const launch = JSON.parse(fs.readFileSync(launches, 'utf8').trim());
      expect(launch.managed).toBe('worker');
      expect(launch.cwd).not.toBe(repo);
      expect(evalGit(repo, ['rev-parse', 'HEAD'])).toBe(before);
      expect(fs.readFileSync(path.join(repo, 'answer.txt'), 'utf8')).toBe('fixed');
      expect(fs.readFileSync(configFile, 'utf8')).toBe(initialConfig);
      expect(fs.existsSync(path.join(repo, '.softwareagents/evals/results.jsonl'))).toBe(false);
      const records = await readRecords();
      expect(records.invalidLines).toBe(0);
      expect(
        fs
          .readdirSync(evalResultsDirectory(path.join(repo, '.git'), 'test'))
          .every((name) => name.endsWith('.jsonl')),
      ).toBe(true);
      expect(JSON.stringify(records)).not.toMatch(
        /PROMPT_SECRET|OUTPUT_SECRET|instructions|append-system-prompt/,
      );
      expect(fs.existsSync(path.join(repo, '.git/softwareagents/work.sqlite3'))).toBe(false);
      for (const name of fs.readdirSync(path.join(repo, '.git/softwareagents/runs')))
        expect(
          fs.readFileSync(path.join(repo, '.git/softwareagents/runs', name), 'utf8'),
        ).not.toMatch(/PROMPT_SECRET|OUTPUT_SECRET|resultSummary/);
    },
    30_000,
  );
  it.each(['claude', 'codex'] as const)(
    '%s records a failing acceptance criterion',
    async (executor) => {
      vi.stubEnv('SA_EVAL_FAKE_MODE', 'criterion-fail');
      const result = await run(executor);
      expect(result.results[0]).toMatchObject({ status: 'criterion_failed', criteria: [false] });
      expect(result.configurations[0]).toMatchObject({
        successes: 0,
        successRate: 0,
        costPerSolvedTaskUsd: 'unknown',
      });
    },
    30_000,
  );
  it.each(['claude', 'codex'] as const)(
    '%s detects inconsistent repetitions and freezes Operator prices',
    async (executor) => {
      vi.stubEnv('SA_EVAL_FAKE_MODE', 'inconsistent');
      const log = vi.fn();
      await runEvalCommand(
        [
          'run',
          '--task',
          'all',
          '--executor',
          executor,
          '--tier',
          'economy',
          '--repeat',
          '2',
          '--yes',
          '--json',
        ],
        {
          cwd: repo,
          log,
          worker: { binaryArgs: [fake, executor], probe: ready },
        },
      );
      const result = JSON.parse(log.mock.calls[0][0]);
      expect(result.results.map((r: { status: string }) => r.status)).toEqual([
        'success',
        'criterion_failed',
      ]);
      expect(result.configurations[0]).toMatchObject({
        attempts: 2,
        successRate: 0.5,
        consistency: 0,
      });
      fs.writeFileSync(configFile, JSON.stringify({ projects: {} }));
      const out = vi.fn();
      await runEvalCommand(['report', '--json'], { cwd: repo, log: out });
      expect(JSON.parse(out.mock.calls[0][0]).configurations).toEqual(result.configurations);
    },
    30_000,
  );
  it.each(['claude', 'codex'] as const)(
    '%s detects an AgentSpec regression against the stored baseline',
    async (executor) => {
      await run(executor);
      const spec = loadWorkerAgentSpec();
      spec.identity.mission = 'REGRESSION_SPEC';
      const file = path.join(root, 'regression.json');
      fs.writeFileSync(file, JSON.stringify(spec));
      const result = await run(executor, ['--agent-spec', file]);
      expect(result.results[0].status).toBe('executor_error');
      expect(result.regressionDetected).toBe(true);
      const variant = result.configurations.find((c: { baseline: boolean }) => !c.baseline);
      expect(variant.regressions).toEqual([
        expect.objectContaining({ task: 'answer', baselineRate: 1, rate: 0 }),
      ]);
      expect(JSON.stringify(result)).not.toContain('REGRESSION_SPEC');
      const out = vi.fn();
      await runEvalCommand(['report', '--json'], { cwd: repo, log: out });
      expect(JSON.parse(out.mock.calls[0][0]).regressionDetected).toBe(true);
    },
    30_000,
  );
  it('fails integrity before restoring a verifier corrupted by the executor', async () => {
    vi.stubEnv('SA_EVAL_FAKE_MODE', 'tamper');
    expect((await run('codex')).results[0]).toMatchObject({
      status: 'criteria_tampered',
      criteria: [],
    });
  }, 30_000);
  it('rejects expect.extend poisoning from an unallowed imported file', async () => {
    vi.stubEnv('SA_EVAL_FAKE_MODE', 'poison');
    expect((await run('codex')).results[0]).toMatchObject({
      status: 'criteria_tampered',
      criteria: [],
    });
  }, 30_000);
  it('never counts an unmatched test name as success', async () => {
    task.criteria[0].testName = 'no matching tests';
    fs.writeFileSync(path.join(repo, '.softwareagents/evals/answer.json'), JSON.stringify(task));
    expect((await run('codex')).results[0].status).toBe('criterion_failed');
  }, 30_000);
  it('keeps missing prices unknown and rejects content-bearing result fields', async () => {
    const config = JSON.parse(initialConfig);
    delete config.projects.test.telemetry;
    fs.writeFileSync(configFile, JSON.stringify(config));
    const result = await run('codex');
    expect(result.configurations[0]).toMatchObject({
      costPerSolvedTaskUsd: 'unknown',
      pareto: 'unknown',
    });
    expect(result.results[0].executionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(() => parseEvalRecord({ ...result.results[0], prompt: 'forbidden' })).toThrow();
    expect(() =>
      parseEvalRecord({ ...result.results[0], metrics: { output: 'forbidden' } }),
    ).toThrow();
  }, 30_000);
  it('rebuilds aggregates, Pareto and consistency from JSONL and counts invalid/duplicate rows', async () => {
    const result = await run('codex');
    const dir = evalResultsDirectory(path.join(repo, '.git'), 'test');
    const file = path.join(dir, `${result.runId}.jsonl`);
    fs.appendFileSync(file, 'partial\n' + JSON.stringify(result.results[0]) + '\n');
    const read = await readRecords();
    expect(read.invalidLines).toBe(2);
    expect(buildEvalReport(read.records).configurations).toEqual(result.configurations);
    const worse = {
      ...read.records[0],
      agentSpecHash: 'a'.repeat(64),
      baseline: false,
      price: { input: 100, output: 200, cacheRead: 50 },
    };
    const report = buildEvalReport([...read.records, worse]);
    expect(report.configurations.find((c) => !c.baseline)?.pareto).toBe(false);
  }, 30_000);
});
