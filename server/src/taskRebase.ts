import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { ProjectConfig } from '../../core/src/project.js';
import { AuditLog } from './auditLog.js';
import { taskPath } from './commands/taskFiles.js';
import { TASK_CLI_INPUT_BYTES } from './constants.js';
import { developerRequest } from './developer.js';
import { evalChangedFiles } from './evalIntegrity.js';
import { evalGit } from './evalTasks.js';
import { featureIngressActor } from './featureIngress.js';
import { featureBaseBranch } from './featureRunBase.js';
import { taskBranchBase, taskBranchBaseFile } from './taskBranchBase.js';
import { type TaskRebase } from './taskRebaseHistory.js';
import type { WorkStore } from './workstore/WorkStore.js';

/** Reconcile only a runtime-authored rebase journal against its two known Git states. */
export async function recoverFeatureTaskRebase(
  store: WorkStore,
  config: ProjectConfig,
  key: string,
): Promise<void> {
  const task = store.getTask(key);
  if (!task?.review_ref || task.lease_owner || task.status === 'WAITING_HUMAN') return;
  const registry = taskBranchBaseFile(config.repoRoot, task.review_ref.branch);
  const journal = registry + '.rebase';
  if (!fs.existsSync(journal)) return;
  const current = task.review_ref;
  await store.reconcileTaskRebase(key, task.version, current, () => {
    const entry = JSON.parse(fs.readFileSync(journal, 'utf8')) as TaskRebase;
    const equal = (ref: typeof current) => JSON.stringify(ref) === JSON.stringify(current);
    if (
      (!equal(entry.before) && !equal(entry.after)) ||
      entry.before.branch !== entry.after.branch ||
      entry.before.branch !== `sa/${key}-developer`
    )
      throw new Error('Rebase journal does not match WorkStore; human reconciliation required');
    const tree = taskPath(config.repoRoot, `.worktrees/${key}`);
    const git = (args: string[]) =>
      evalGit(tree, ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', ...args]);
    if (
      task.worktree_ref !== tree ||
      git(['symbolic-ref', '--short', 'HEAD']) !== current.branch ||
      ![entry.before.sha, entry.after.sha].includes(git(['rev-parse', 'HEAD']))
    )
      throw new Error('Rebase journal branch changed');
    const files = new Set<string>();
    const blobs = [entry.before.sha, entry.after.sha].map(
      (sha) =>
        new Map(
          git(['ls-tree', '-r', '-z', sha])
            .split('\0')
            .filter(Boolean)
            .map((line) => {
              const [metadata, file] = line.split('\t');
              files.add(file);
              return [file, metadata.split(' ')[2]] as const;
            }),
        ),
    );
    const inspect = (directory: string, prefix = '') => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!prefix && entry.name === '.git') continue;
        const relative = prefix + entry.name;
        const target = path.join(directory, entry.name);
        if (fs.lstatSync(target).isSymbolicLink())
          throw new Error('Rebase journal worktree has a link');
        if (entry.isDirectory()) {
          if (![...files].some((file) => file.startsWith(relative + '/')))
            throw new Error('Rebase journal worktree has foreign directories');
          inspect(target, relative + '/');
        } else if (!files.has(relative))
          throw new Error('Rebase journal worktree has foreign files');
      }
    };
    inspect(tree);
    const knownTrees = [entry.before.sha, entry.after.sha].map((sha) =>
      git(['rev-parse', `${sha}^{tree}`]),
    );
    if (
      !knownTrees.includes(git(['write-tree'])) ||
      git(['ls-files', '-v', '-z'])
        .split('\0')
        .some((line) => line && !line.startsWith('H '))
    )
      throw new Error('Rebase journal index changed or hides files');
    for (const file of files) {
      const source = taskPath(tree, file);
      if (!fs.existsSync(source)) {
        if (blobs.every((map) => map.has(file)))
          throw new Error('Rebase journal has a missing tracked file');
        continue;
      }
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error('Rebase journal worktree contains a special file');
      const content = fs.readFileSync(source);
      if (
        !blobs.some((map) => {
          if (!map.has(file)) return false;
          const expected = map.get(file)!;
          const digest = (bytes: Buffer) =>
            createHash(expected.length === 64 ? 'sha256' : 'sha1')
              .update(`blob ${bytes.length}\0`)
              .update(bytes)
              .digest('hex');
          return (
            digest(content) === expected ||
            (!content.includes(0) &&
              digest(Buffer.from(content.toString('latin1').replaceAll('\r\n', '\n'), 'latin1')) ===
                expected)
          );
        })
      )
        throw new Error('Rebase journal worktree has foreign edits');
    }
    if (git(['ls-files', '--others', '--exclude-standard']))
      throw new Error('Rebase journal worktree has foreign files');
    const head = git(['rev-parse', 'HEAD']);
    git(['update-ref', `refs/heads/${current.branch}`, current.sha, head]);
    git(['read-tree', '--reset', '-u', current.sha]);
    const temporary = registry + `.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ branch: current.branch, base: current.base }), {
      flag: 'wx',
    });
    fs.renameSync(temporary, registry);
    new AuditLog().append({
      projectId: store.projectId,
      action: 'feature_rebase',
      resourceType: 'task',
      resourceId: key,
      actorType: 'system',
      actorId: 'rebase-recovery',
      policyDecision: null,
      riskLevel: 'high',
      taskKey: key,
      executionId: null,
      outcome: { status: 'reconciled', detail: JSON.stringify({ review_ref: current }) },
    });
    fs.unlinkSync(journal);
  });
}

/** Operator-authorized maintenance, including an admitted feature runner. No executor or push. */
export async function rebaseFeatureTask(
  store: WorkStore,
  config: ProjectConfig,
  feature: string,
  key: string,
  audit = new AuditLog(),
  orchestratorOwner?: string,
): Promise<TaskRebase> {
  const actor = featureIngressActor();
  let result: TaskRebase | undefined;
  const append = (status: string) =>
    audit.append({
      projectId: store.projectId,
      action: 'feature_rebase',
      resourceType: 'task',
      resourceId: key,
      actorType: actor,
      actorId: actor === 'human' ? 'operator' : null,
      policyDecision: null,
      riskLevel: 'high',
      taskKey: key,
      executionId: null,
      outcome: { status, detail: JSON.stringify(result ?? {}) },
    });
  const orchestrated =
    orchestratorOwner !== undefined &&
    store.getFeatureRun(feature)?.owner === orchestratorOwner &&
    store.getFeatureRun(feature)?.pid === process.pid;
  if (actor !== 'human' && !orchestrated) {
    append('rejected');
    throw new Error('Feature rebase requires the human operator');
  }
  await recoverFeatureTaskRebase(store, config, key);
  const task = store.getTask(key);
  if (
    !task?.review_ref ||
    task.feature_key !== feature ||
    task.lease_owner ||
    !['REVIEW', 'QA'].includes(task.status)
  )
    throw new Error('Rebase requires an idle REVIEW or QA task with a valid review_ref');
  developerRequest(store, config, feature, key, undefined, true);
  const before = task.review_ref;
  const root = config.repoRoot;
  const tree = taskPath(root, `.worktrees/${key}`);
  const common = evalGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const baseBranch = featureBaseBranch(store, config, feature);
  evalGit(root, ['check-ref-format', '--branch', baseBranch]);
  const base = evalGit(root, ['rev-parse', `refs/heads/${baseBranch}^{commit}`]);
  const assertSource = () => {
    if (
      task.worktree_ref !== tree ||
      task.branch !== before.branch ||
      before.branch !== `sa/${key}-developer` ||
      !/^[a-f0-9]{40,64}$/.test(before.sha) ||
      !/^[a-f0-9]{40,64}$/.test(before.base) ||
      taskBranchBase(root, before.branch, baseBranch) !== before.base ||
      evalGit(root, ['rev-parse', `refs/heads/${before.branch}`]) !== before.sha ||
      evalGit(tree, ['rev-parse', 'HEAD']) !== before.sha ||
      evalGit(tree, ['symbolic-ref', '--short', 'HEAD']) !== before.branch ||
      fs.realpathSync.native(
        evalGit(tree, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      ) !== fs.realpathSync.native(common) ||
      evalGit(root, ['rev-parse', `refs/heads/${baseBranch}`]) !== base
    )
      throw new Error('Rebase review_ref SHA/base/branch or Project base changed');
    // Inspect directory entries before Git can enumerate ignored junction targets.
    // Empty untracked directories are residues too, although Git does not report them.
    const tracked = new Set(evalGit(tree, ['ls-files', '-z']).split('\0').filter(Boolean));
    const directories = new Set<string>();
    for (const file of tracked) {
      let directory = path.posix.dirname(file);
      while (directory !== '.') {
        directories.add(directory);
        directory = path.posix.dirname(directory);
      }
    }
    const residues: string[] = [];
    const inspect = (directory: string, prefix = '') => {
      for (const name of fs.readdirSync(directory)) {
        if (!prefix && name === '.git') continue;
        const relative = prefix + name;
        const child = path.join(directory, name);
        const stat = fs.lstatSync(child);
        if (stat.isDirectory() && !stat.isSymbolicLink() && directories.has(relative))
          inspect(child, relative + '/');
        else if (!tracked.has(relative)) residues.push(relative);
      }
    };
    inspect(tree);
    if (residues.length)
      throw new Error(
        `Rebase requires a clean worktree; residues: ${JSON.stringify(residues.sort())}`,
      );
    const dirty = evalChangedFiles(tree, before.sha);
    if (dirty.length)
      throw new Error(
        `Rebase requires a clean worktree; residues: ${JSON.stringify(dirty.sort())}`,
      );
    const hidden = evalGit(tree, ['ls-files', '-v', '-z'])
      .split('\0')
      .filter((entry) => entry && !entry.startsWith('H '));
    if (hidden.length) throw new Error(`Rebase index hides changes: ${JSON.stringify(hidden)}`);
    for (const state of [
      'MERGE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'rebase-merge',
      'rebase-apply',
    ])
      if (
        fs.existsSync(evalGit(tree, ['rev-parse', '--path-format=absolute', '--git-path', state]))
      )
        throw new Error(`Rebase refuses an unfinished Git operation: ${state}`);
  };
  assertSource();
  const registry = taskBranchBaseFile(root, before.branch);
  const originalRegistry = fs.readFileSync(registry);
  const journal = registry + '.rebase';
  const scratch = taskPath(common, `softwareagents/rebases/${randomUUID()}`);
  const staging = path.join(scratch, 'tree');
  const hooks = path.join(scratch, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const git = (cwd: string, args: string[]) =>
    evalGit(cwd, ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', ...args]);
  const patchId = (base: string, sha: string) => {
    const diff = execFileSync(
      'git',
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--binary',
        '--full-index',
        `${base}..${sha}`,
        '--',
      ],
      { cwd: root, windowsHide: true, maxBuffer: TASK_CLI_INPUT_BYTES },
    );
    return execFileSync('git', ['patch-id', '--stable'], {
      cwd: root,
      input: diff,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: TASK_CLI_INPUT_BYTES,
    })
      .trim()
      .split(/\s/)[0];
  };
  // Atomic replacement, never expose half a JSON record to another reader.
  const writeRegistry = (content: string | Buffer) => {
    const temporary = registry + `.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, content, { flag: 'wx' });
      fs.renameSync(temporary, registry);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  };
  let registered = false;
  let reserved = false;
  let moved = false;
  try {
    git(root, ['worktree', 'add', '--detach', staging, before.sha]);
    registered = true;
    try {
      git(staging, [
        '-c',
        'rebase.autoStash=false',
        'rebase',
        '--no-autostash',
        '--no-gpg-sign',
        '--no-update-refs',
        '--no-rebase-merges',
        '--onto',
        base,
        before.base,
      ]);
    } catch (cause) {
      for (const state of ['rebase-merge', 'rebase-apply'])
        if (
          fs.existsSync(git(staging, ['rev-parse', '--path-format=absolute', '--git-path', state]))
        ) {
          git(staging, ['rebase', '--abort']);
          break;
        }
      throw new Error('Rebase conflict or failure; task branch, worktree and records unchanged', {
        cause,
      });
    }
    const after = { branch: before.branch, sha: git(staging, ['rev-parse', 'HEAD']), base };
    result = {
      before,
      after,
      oldPatchId: patchId(before.base, before.sha),
      newPatchId: patchId(base, after.sha),
    };
    await store.rebaseTask(
      key,
      task.version,
      result,
      () => {
        assertSource();
        fs.writeFileSync(journal, JSON.stringify(result), { flag: 'wx' });
        reserved = true;
        append('pending');
        git(root, ['update-ref', `refs/heads/${before.branch}`, after.sha, before.sha]);
        moved = true;
        git(tree, ['read-tree', '--reset', '-u', after.sha]);
        writeRegistry(JSON.stringify({ branch: after.branch, base }));
        if (
          evalChangedFiles(tree, after.sha).length ||
          git(tree, ['rev-parse', 'HEAD']) !== after.sha ||
          git(root, ['rev-parse', `refs/heads/${baseBranch}`]) !== base
        )
          throw new Error('Rebase publication changed; rolling back');
      },
      () => {
        if (moved) {
          // CAS protects an unexpected external branch write from being overwritten.
          git(root, ['update-ref', `refs/heads/${before.branch}`, before.sha, after.sha]);
          git(tree, ['read-tree', '--reset', '-u', before.sha]);
          writeRegistry(originalRegistry);
          moved = false;
        }
        if (reserved) {
          fs.unlinkSync(journal);
          reserved = false;
        }
      },
    );
    // A crash leaves the journal in place: all task-base consumers fail closed until reconciled.
    fs.unlinkSync(journal);
    reserved = false;
    try {
      append('persisted');
    } catch (cause) {
      throw new Error(
        'Rebase persisted; audit confirmation pending. Inspect WorkStore before retrying.',
        { cause },
      );
    }
    return result;
  } finally {
    if (registered) {
      // Unlink entries without visiting their targets, then verify before Git removes the tree.
      const inspect = (directory: string, unlink: boolean) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const child = path.join(directory, entry.name);
          if (fs.lstatSync(child).isSymbolicLink()) {
            if (!unlink)
              throw new Error(`Rebase scratch retained: link at ${JSON.stringify(child)}`);
            fs.unlinkSync(child);
          } else if (entry.isDirectory()) inspect(child, unlink);
        }
      };
      inspect(staging, true);
      inspect(staging, false);
      git(root, ['worktree', 'remove', '--force', staging]);
    }
    fs.rmdirSync(hooks);
    fs.rmdirSync(scratch);
  }
}
