import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditLog } from '../src/auditLog.js';
import { dispatchCli } from '../src/cli.js';
import { parseProjects } from '../src/configPersistence.js';
import { ExecutionRegistry } from '../src/executors/executionRegistry.js';
import { guardProtectedPaths } from '../src/executors/protectedPaths.js';
import { loadProjectConfig } from '../src/projectConfig.js';
import { acquireTaskLock, parseWorkerArgs, runWorker } from '../src/worker.js';

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => process.env.HOME ?? actual.homedir()) };
});

let root: string;
let repo: string;
const fake = path.join(__dirname, 'fixtures/fake-cli.cjs');
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  vi.stubEnv('HOME', root);
  vi.stubEnv('GIT_AUTHOR_NAME', 'Test');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'test@example.invalid');
  vi.stubEnv('GIT_COMMITTER_NAME', 'Test');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'test@example.invalid');
  git(repo, 'init', '-b', 'main');
  fs.mkdirSync(path.join(repo, '.softwareagents'));
  fs.writeFileSync(
    path.join(repo, '.softwareagents/project.yaml'),
    'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: test\nname: Test\nrepo:\n  remote: https://example.invalid/test.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n',
  );
  fs.writeFileSync(path.join(repo, 'brief.md'), 'Correct documentation.');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  fs.mkdirSync(path.join(root, '.pixel-agents'));
  fs.writeFileSync(
    path.join(root, '.pixel-agents/config.json'),
    JSON.stringify({
      projects: {
        test: {
          autonomyLevel: 'A1',
          allowedExecutors: ['claude'],
          binaryPaths: { claude: process.execPath },
        },
      },
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('supervised worker', () => {
  it('dispatches default and --port to the server, worker to its own handler', async () => {
    const server = vi.fn(async () => {});
    const worker = vi.fn(async () => ({ branch: '', commit: null, stat: '' }));
    await dispatchCli([], { server, worker });
    await dispatchCli(['--port', '8123'], { server, worker });
    await dispatchCli(['worker', 'run', '--task', 'SA-999', '--brief', 'brief.md'], {
      server,
      worker,
    });
    expect(server.mock.calls).toEqual([[[]], [['--port', '8123']]]);
    expect(worker).toHaveBeenCalledWith({ task: 'SA-999', brief: 'brief.md' });
  });
  it('rejects malformed arguments', () => {
    for (const args of [
      [],
      ['run'],
      ['run', '--task', '../main', '--brief', 'a'],
      ['run', '--task', 'SA-999', '--brief', 'a', '--push', 'yes'],
    ])
      expect(() => parseWorkerArgs(args)).toThrow();
  });
  it('retains live and crashed locks until verified manual recovery', () => {
    const common = path.join(repo, '.git');
    const release = acquireTaskLock(common, 'SA-999');
    const lock = path.join(common, 'softwareagents/locks/SA-999.lock');
    expect(fs.readFileSync(lock, 'utf8')).toBe(String(process.pid));
    expect(() => acquireTaskLock(common, 'SA-999')).toThrow('Task locked');
    release();
    fs.writeFileSync(lock, '2147483647');
    expect(() => acquireTaskLock(common, 'SA-999')).toThrow('Verify owner PID');
    fs.unlinkSync(lock); // Operator verified owner and executor child are gone.
    acquireTaskLock(common, 'SA-999')();
    expect(fs.existsSync(lock)).toBe(false);
  });
  it('runs fake CLI through runtime commit, registry and audit, keeps main intact and blocks agent pushes', async () => {
    const main = git(repo, 'rev-parse', 'main');
    const log = vi.fn();
    const result = await runWorker(
      { task: 'SA-999', brief: 'brief.md' },
      {
        cwd: repo,
        binaryArgs: [fake, 'claude', '--write-doc'],
        log,
      },
    );
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.branch).toBe('sa/SA-999-worker');
    expect(result.stat).toContain('worker-result.md');
    expect(git(repo, 'rev-parse', 'main')).toBe(main);
    const tree = path.join(repo, '.worktrees/SA-999');
    // The supervised worker skips npm ci but keeps the per-worktree push block.
    expect(git(tree, 'config', '--worktree', 'remote.origin.pushurl')).toBe(
      'softwareagents-push-disabled://origin',
    );
    expect(git(tree, 'status', '--porcelain')).toBe('');
    expect(git(tree, 'log', '-1', '--format=%B')).toContain('SoftwareAgents-Execution:');
    expect(new ExecutionRegistry(tree).sessionMap().values().next().value).toMatchObject({
      role: 'developer',
      taskKey: 'SA-999',
    });
    expect(new AuditLog().read('test')).toMatchObject([
      {
        corrupt: false,
        entry: {
          actorType: 'human',
          taskKey: 'SA-999',
          policyDecision: { outcome: 'allow' },
          outcome: { status: 'ready_for_review' },
        },
      },
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('rama lista para revisión'));
  });
  it('blocks protected changes before commit and audits require_human', async () => {
    const base = git(repo, 'rev-parse', 'HEAD');
    const result = await runWorker(
      { task: 'SA-999', brief: 'brief.md' },
      {
        cwd: repo,
        binaryArgs: [fake, 'claude', '--write-protected'],
        log: vi.fn(),
      },
    );
    expect(result).toMatchObject({ commit: null, policyDecision: { outcome: 'require_human' } });
    expect(git(repo, 'rev-parse', result.branch)).toBe(base);
    expect(new AuditLog().read('test')).toMatchObject([
      {
        entry: {
          action: 'touch_protected_path',
          actorType: 'system',
          taskKey: 'SA-999',
          policyDecision: { outcome: 'require_human' },
          outcome: { status: 'require_human' },
        },
      },
    ]);
  });
  it('checks committed and staged changes, scripts and additive operator paths', () => {
    const base = git(repo, 'rev-parse', 'HEAD');
    const config = loadProjectConfig(repo)!;
    const check = (staged = true) =>
      guardProtectedPaths({
        cwd: repo,
        base,
        staged,
        operator: config.operator,
        projectId: 'test',
      });
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'test' }));
    git(repo, 'add', '.');
    expect(check().decision.outcome).toBe('allow');
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ scripts: { test: 'evil' } }),
    );
    git(repo, 'add', '.');
    expect(check().paths).toEqual(['package.json']);
    git(repo, 'commit', '-m', 'scripts');
    expect(check(false).decision.outcome).toBe('require_human');
    config.operator.protectedPaths = [];
    fs.writeFileSync(path.join(repo, '.softwareagents/project.yaml'), 'protectedPaths: []');
    git(repo, 'add', '.');
    expect(check().paths).toContain('.softwareagents/project.yaml');
    config.operator.protectedPaths = ['brief.md'];
    fs.writeFileSync(path.join(repo, 'brief.md'), 'changed');
    git(repo, 'add', '.');
    expect(check().paths).toContain('brief.md');
    expect(
      guardProtectedPaths({
        cwd: repo,
        base,
        staged: true,
        operator: config.operator,
        projectId: 'test',
        actor: 'human',
      }).decision.outcome,
    ).toBe('allow');
  });
  it('protects every default, renames out of protected paths, and fails closed on audit errors', () => {
    const files = [
      '.github/workflows/ci.yml',
      '.claude/settings.json',
      '.softwareagents/agents/developer.yaml',
      'agents/templates/developer.yaml',
      'CODEOWNERS',
      'esbuild.js',
      'scripts/run.js',
    ];
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), 'original');
    }
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'protected base');
    const base = git(repo, 'rev-parse', 'HEAD');
    for (const file of files) fs.writeFileSync(path.join(repo, file), 'changed');
    git(repo, 'mv', 'scripts/run.js', 'ordinary.js');
    git(repo, 'add', '.');
    const operator = loadProjectConfig(repo)!.operator;
    expect(
      parseProjects({ test: { ...operator, protectedPaths: ['extra/**'] } }).test.protectedPaths,
    ).toEqual(['extra/**']);
    const options = { cwd: repo, base, staged: true, operator, projectId: 'test' };
    expect(guardProtectedPaths(options).paths).toEqual(expect.arrayContaining(files));
    expect(() => guardProtectedPaths({ ...options, base: 'missing-base' })).toThrow();
    const append = vi.spyOn(AuditLog.prototype, 'append').mockImplementation(() => {
      throw new Error('audit unavailable');
    });
    try {
      expect(() => guardProtectedPaths(options)).toThrow('audit unavailable');
    } finally {
      append.mockRestore();
    }
  });
  it('does not commit an execution with no changes', async () => {
    const base = git(repo, 'rev-parse', 'HEAD');
    const result = await runWorker(
      { task: 'SA-999', brief: 'brief.md' },
      {
        cwd: repo,
        binaryArgs: [fake, 'claude'],
        log: vi.fn(),
      },
    );
    expect(result.commit).toBeNull();
    expect(git(repo, 'rev-parse', result.branch)).toBe(base);
    expect(new AuditLog().read('test')).toMatchObject([
      { entry: { outcome: { status: 'no_changes' } } },
    ]);
  });
  it('keeps failed execution edits uncommitted and refuses dirty retries', async () => {
    const options = { cwd: repo, binaryArgs: [fake, 'claude', '--write-doc', '--fail'] };
    await expect(runWorker({ task: 'SA-999', brief: 'brief.md' }, options)).rejects.toThrow(
      'Execution failed',
    );
    expect(git(repo, 'rev-parse', 'sa/SA-999-worker')).toBe(git(repo, 'rev-parse', 'main'));
    await expect(runWorker({ task: 'SA-999', brief: 'brief.md' }, options)).rejects.toThrow(
      'dirty',
    );
  });
  it('fails closed without operator executor authorization', async () => {
    fs.writeFileSync(path.join(root, '.pixel-agents/config.json'), '{}');
    await expect(runWorker({ task: 'SA-999', brief: 'brief.md' }, { cwd: repo })).rejects.toThrow(
      'Operator config',
    );
    expect(fs.existsSync(path.join(repo, '.worktrees'))).toBe(false);
  });
});
