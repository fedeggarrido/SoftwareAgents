import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { promisify } from 'util';

import { resolveInside } from '../pathGuard.js';

const execute = promisify(execFile);
const BLOCKED_PUSH_URL = 'softwareagents-push-disabled://origin';

export interface WorktreeResult {
  path: string;
  branch: string;
  reused: boolean;
  bootstrap: { durationMs: number; cached: boolean; skipped: boolean };
}

export interface WorktreeManagerOptions {
  /** Main checkout of the Managed Project, never an Execution worktree. */
  repositoryPath: string;
  defaultBranch: string;
  protectedBranches?: readonly string[];
  /** Trusted operator path; invoking node avoids npm.cmd shell quoting on Windows. */
  npmCliPath?: string;
}

/** Serializes operations in this instance. The runtime must hold the Project Lease across processes. */
export class WorktreeManager {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly root: string;

  constructor(private readonly options: WorktreeManagerOptions) {
    this.root = fs.realpathSync.native(options.repositoryPath);
  }

  create(taskKey: string, slug: string): Promise<WorktreeResult> {
    return this.serial(async () => {
      const { directory, branch } = this.target(taskKey, slug);
      await this.assertMainRepository();
      const existing = await this.registered(directory);
      if (existing) {
        await this.assertTask(directory, branch);
      } else {
        if (fs.existsSync(directory)) {
          throw new Error('Task path exists but is not a registered worktree');
        }
        await this.git(this.root, ['check-ref-format', '--branch', branch]);
        // A failed bootstrap can leave a branch behind after cleanup; reuse its commits.
        const branches = await this.git(this.root, [
          'for-each-ref',
          '--format=%(refname)',
          `refs/heads/${branch}`,
        ]);
        await this.git(this.root, [
          'worktree',
          'add',
          ...(branches.split('\n').includes(`refs/heads/${branch}`) ? [] : ['-b', branch]),
          directory,
          branches.split('\n').includes(`refs/heads/${branch}`)
            ? branch
            : this.options.defaultBranch,
        ]);
      }
      // worktreeConfig affects all checkouts: refuse configurations that need migration.
      await this.git(this.root, ['config', '--local', 'extensions.worktreeConfig', 'true']);
      await this.git(directory, [
        'config',
        '--worktree',
        '--replace-all',
        'remote.origin.pushurl',
        BLOCKED_PUSH_URL,
      ]);
      const bootstrap = await this.bootstrap(directory);
      return { path: directory, branch, reused: existing, bootstrap };
    });
  }

  /** Call after merge or cancellation. discardChanges represents an explicit Gate decision. */
  cleanup(
    taskKey: string,
    slug: string,
    options: { discardChanges?: boolean } = {},
  ): Promise<void> {
    return this.serial(async () => {
      const { directory, branch } = this.target(taskKey, slug);
      await this.assertMainRepository();
      if (!(await this.registered(directory))) {
        if (fs.existsSync(directory)) {
          throw new Error('Refusing to remove an unregistered directory');
        }
        await this.git(this.root, ['worktree', 'prune']);
        return;
      }
      await this.assertTask(directory, branch);
      const dirty = await this.git(directory, ['status', '--porcelain', '--untracked-files=all']);
      if (dirty && !options.discardChanges) {
        throw new Error('Cleanup Gate: worktree has uncommitted changes');
      }
      // Never let recursive removal follow a junction, including links installed by scripts.
      this.visitLinks(directory, (link) => fs.unlinkSync(link));
      await this.git(this.root, ['worktree', 'remove', '--force', directory]);
      await this.git(this.root, ['worktree', 'prune']);
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private target(taskKey: string, slug: string): { directory: string; branch: string } {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(taskKey) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new Error('Expected a safe Task key and lowercase slug');
    }
    const branch = `sa/${taskKey}-${slug}`;
    const protectedBranches = [
      'main',
      'master',
      this.options.defaultBranch,
      ...(this.options.protectedBranches ?? []),
    ];
    if (protectedBranches.some((name) => name.toLowerCase() === branch.toLowerCase())) {
      throw new Error('Protected branch');
    }
    return { directory: resolveInside(this.root, `.worktrees/${taskKey}`), branch };
  }

  private async assertMainRepository(): Promise<void> {
    const common = await this.git(this.root, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    const gitDir = await this.git(this.root, ['rev-parse', '--absolute-git-dir']);
    if (fs.realpathSync.native(common) !== fs.realpathSync.native(gitDir)) {
      throw new Error('Repository path must be the main checkout');
    }
    const config = await this.git(this.root, ['config', '--local', '--list']);
    if (/^core\.(worktree=|bare=true$)/m.test(config)) {
      throw new Error('Repository requires worktreeConfig migration before use');
    }
    // Git accumulates pushurl values across scopes instead of overriding them.
    // Adding an invalid worktree URL would still push to an inherited valid URL.
    const effectiveConfig = await this.git(this.root, ['config', '--list']);
    if (/^remote\.origin\.pushurl=/m.test(effectiveConfig)) {
      throw new Error('Inherited origin pushurl must be removed before managing worktrees');
    }
    await this.git(this.root, ['check-ref-format', '--branch', this.options.defaultBranch]);
  }

  private async registered(directory: string): Promise<boolean> {
    const list = await this.git(this.root, ['worktree', 'list', '--porcelain', '-z']);
    return list.split('\0').some((entry) => {
      if (!entry.startsWith('worktree ')) {
        return false;
      }
      const registeredPath = path.resolve(entry.slice('worktree '.length));
      return process.platform === 'win32'
        ? registeredPath.toLowerCase() === directory.toLowerCase()
        : registeredPath === directory;
    });
  }

  private async assertTask(directory: string, branch: string): Promise<void> {
    if (fs.realpathSync.native(directory) === this.root) {
      throw new Error('Refusing the main checkout');
    }
    const current = await this.git(directory, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (current !== branch) {
      throw new Error('Worktree belongs to another Task or a protected branch');
    }
  }

  private git(cwd: string, args: string[]): Promise<string> {
    return execute('git', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }).then(
      ({ stdout }) => stdout.trim(),
    );
  }

  private visitLinks(directory: string, visit: (link: string) => void): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (fs.lstatSync(child).isSymbolicLink()) {
        visit(child);
      } else if (entry.isDirectory()) {
        this.visitLinks(child, visit);
      }
    }
  }

  private async bootstrap(directory: string): Promise<WorktreeResult['bootstrap']> {
    const started = performance.now();
    if (!fs.existsSync(path.join(directory, 'package.json'))) {
      return { durationMs: performance.now() - started, cached: false, skipped: true };
    }
    // Fail closed on linked dependencies: npm ci removes node_modules recursively.
    this.visitLinks(directory, (link) => {
      const relative = path.relative(directory, fs.realpathSync.native(link));
      if (
        path.basename(link) === 'node_modules' ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new Error(`Bootstrap refuses dependencies linked outside the worktree: ${link}`);
      }
    });
    const lock = resolveInside(directory, 'package-lock.json');
    const fingerprint = createHash('sha256')
      .update(fs.readFileSync(lock))
      .update(fs.readFileSync(resolveInside(directory, 'package.json')))
      .update(process.version)
      .update(process.platform)
      .update(process.arch);
    const manifests = await this.git(directory, [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'package.json',
      '*/package.json',
      '.npmrc',
      '*/.npmrc',
    ]);
    for (const manifest of [...new Set(manifests.split('\0').filter(Boolean))].sort()) {
      fingerprint.update(manifest).update(fs.readFileSync(resolveInside(directory, manifest)));
    }
    const hash = fingerprint.digest('hex');
    const config = await this.git(directory, ['config', '--worktree', '--list']);
    if (
      config.split('\n').includes(`softwareagents.bootstrap=${hash}`) &&
      fs.existsSync(path.join(directory, 'node_modules'))
    ) {
      return { durationMs: performance.now() - started, cached: true, skipped: false };
    }
    const cache = resolveInside(this.root, '.worktrees/.npm-cache');
    fs.mkdirSync(cache, { recursive: true });
    const npmCli =
      this.options.npmCliPath ??
      process.env.npm_execpath ??
      path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    if (config.split('\n').some((line) => line.startsWith('softwareagents.bootstrap='))) {
      await this.git(directory, [
        'config',
        '--worktree',
        '--unset-all',
        'softwareagents.bootstrap',
      ]);
    }
    await execute(
      process.execPath,
      [npmCli, 'ci', '--cache', cache, '--prefer-offline', '--no-audit', '--no-fund'],
      {
        cwd: directory,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, HUSKY: '0' },
      },
    );
    // Empty dependency sets may not create node_modules; keep retries deterministic.
    fs.mkdirSync(resolveInside(directory, 'node_modules'), { recursive: true });
    await this.git(directory, ['config', '--worktree', 'softwareagents.bootstrap', hash]);
    return { durationMs: performance.now() - started, cached: false, skipped: false };
  }
}
