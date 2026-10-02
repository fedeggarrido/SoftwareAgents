import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorktreeManager } from '../src/executors/worktreeManager.js';

describe('Task worktree manager (real Git)', () => {
  let temp: string;
  let root: string;
  let manager: WorktreeManager;
  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }
  function commit(): void {
    git(root, 'add', '.');
    git(
      root,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'fixture',
    );
  }
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-worktrees-'));
    root = path.join(temp, 'project with spaces');
    fs.mkdirSync(root);
    git(root, 'init', '-b', 'main');
    fs.writeFileSync(path.join(root, '.gitignore'), '.worktrees/\nnode_modules/\n');
    fs.writeFileSync(path.join(root, 'file.txt'), 'initial');
    commit();
    const remote = path.join(temp, 'remote.git');
    git(temp, 'init', '--bare', remote);
    git(root, 'remote', 'add', 'origin', remote);
    manager = new WorktreeManager({ repositoryPath: root, defaultBranch: 'main' });
  });
  afterEach(() => {
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it('creates and reuses the same Task, including its uncommitted changes', async () => {
    const first = await manager.create('SA-032', 'worktrees');
    expect(first.path).toBe(path.join(fs.realpathSync.native(root), '.worktrees', 'SA-032'));
    expect(first.branch).toBe('sa/SA-032-worktrees');
    expect(first.reused).toBe(false);
    fs.writeFileSync(path.join(first.path, 'file.txt'), 'Execution progress');
    const retry = await manager.create('SA-032', 'worktrees');
    expect(retry.reused).toBe(true);
    expect(fs.readFileSync(path.join(retry.path, 'file.txt'), 'utf8')).toBe('Execution progress');
    await expect(manager.create('SA-032', 'another-task')).rejects.toThrow('another Task');
  });

  it('blocks origin push with a local remote while explicit runtime push and main still work', async () => {
    const worktree = await manager.create('SA-032', 'worktrees');
    expect(() => git(worktree.path, 'push', 'origin', 'HEAD')).toThrow();
    const remote = git(root, 'remote', 'get-url', 'origin');
    git(worktree.path, 'push', remote, 'HEAD');
    git(root, 'push', 'origin', 'main');
    expect(
      git(temp, '--git-dir', remote, 'show-ref', '--verify', `refs/heads/${worktree.branch}`),
    ).toContain(worktree.branch);
    git(worktree.path, 'config', '--worktree', 'remote.origin.pushurl', remote);
    await manager.create('SA-032', 'worktrees');
    expect(() => git(worktree.path, 'push', 'origin', 'HEAD')).toThrow();
  });

  it('rejects main, protected branches, unmanaged paths and a linked worktree as repository', async () => {
    const directory = path.join(root, '.worktrees', 'SA-032');
    git(root, 'worktree', 'add', '--detach', directory, 'main');
    git(directory, 'checkout', '-b', 'other');
    git(root, 'checkout', '--detach');
    git(directory, 'checkout', 'main');
    fs.writeFileSync(path.join(directory, 'file.txt'), 'dirty other task');
    await expect(manager.create('SA-032', 'worktrees')).rejects.toThrow('protected branch');
    await expect(manager.cleanup('SA-032', 'worktrees', { discardChanges: true })).rejects.toThrow(
      'protected branch',
    );
    const nested = new WorktreeManager({ repositoryPath: directory, defaultBranch: 'main' });
    await expect(nested.create('SA-033', 'nested')).rejects.toThrow('main checkout');
    const protectedManager = new WorktreeManager({
      repositoryPath: root,
      defaultBranch: 'main',
      protectedBranches: ['sa/SA-033-protected'],
    });
    await expect(protectedManager.create('SA-033', 'protected')).rejects.toThrow(
      'Protected branch',
    );
    fs.mkdirSync(path.join(root, '.worktrees', 'SA-034'));
    await expect(manager.create('SA-034', 'unmanaged')).rejects.toThrow('not a registered');
  });

  it('gates dirty cleanup, removes and prunes, and preserves the branch for retry', async () => {
    const worktree = await manager.create('SA-032', 'worktrees');
    fs.writeFileSync(path.join(worktree.path, 'untracked.txt'), 'progress');
    await expect(manager.cleanup('SA-032', 'worktrees')).rejects.toThrow('Cleanup Gate');
    expect(fs.existsSync(worktree.path)).toBe(true);
    await manager.cleanup('SA-032', 'worktrees', { discardChanges: true });
    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain(
      worktree.path.replaceAll('\\', '/'),
    );
    await manager.cleanup('SA-032', 'worktrees');
    expect((await manager.create('SA-032', 'worktrees')).reused).toBe(false);
    await manager.cleanup('SA-032', 'worktrees');
  });

  it('rejects traversal and escaped junction paths', async () => {
    await expect(manager.create('../main', 'escape')).rejects.toThrow();
    await expect(manager.create('SA-032', '../main')).rejects.toThrow();
    fs.symlinkSync(
      temp,
      path.join(root, '.worktrees'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(manager.create('SA-032', 'escape')).rejects.toThrow('inside');
    fs.unlinkSync(path.join(root, '.worktrees'));
  });

  it('refuses inherited push URLs because Git pushes to every configured URL', async () => {
    git(root, 'config', '--local', 'remote.origin.pushurl', path.join(temp, 'remote.git'));
    await expect(manager.create('SA-032', 'worktrees')).rejects.toThrow('Inherited origin pushurl');
    expect(fs.existsSync(path.join(root, '.worktrees', 'SA-032'))).toBe(false);
  });

  it('unlinks dependency junctions before removal without touching their target', async () => {
    const worktree = await manager.create('SA-032', 'worktrees');
    const dependencies = path.join(temp, 'shared dependencies');
    fs.mkdirSync(dependencies);
    fs.writeFileSync(path.join(dependencies, 'keep.txt'), 'keep');
    fs.symlinkSync(
      dependencies,
      path.join(worktree.path, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await manager.cleanup('SA-032', 'worktrees');
    expect(fs.readFileSync(path.join(dependencies, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('runs npm ci with measured bootstrap, caches retries and invalidates package changes', async () => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'bootstrap-fixture', version: '1.0.0' }),
    );
    fs.writeFileSync(
      path.join(root, 'package-lock.json'),
      JSON.stringify({
        name: 'bootstrap-fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: { '': { name: 'bootstrap-fixture', version: '1.0.0' } },
      }),
    );
    commit();
    const first = await manager.create('SA-032', 'bootstrap');
    expect(first.bootstrap).toMatchObject({ cached: false, skipped: false });
    expect(first.bootstrap.durationMs).toBeGreaterThan(0);
    const retry = await new WorktreeManager({ repositoryPath: root, defaultBranch: 'main' }).create(
      'SA-032',
      'bootstrap',
    );
    expect(retry.bootstrap.cached).toBe(true);
    console.info(
      `SA-032 npm ci fixture: ${first.bootstrap.durationMs.toFixed(0)} ms; cached retry: ${retry.bootstrap.durationMs.toFixed(0)} ms`,
    );
    fs.writeFileSync(
      path.join(first.path, 'package.json'),
      JSON.stringify({ name: 'bootstrap-fixture', version: '1.0.0', description: 'changed' }),
    );
    expect((await manager.create('SA-032', 'bootstrap')).bootstrap.cached).toBe(false);
  }, 30_000);
});
