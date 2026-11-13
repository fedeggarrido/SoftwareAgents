import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

import type { ProjectConfig } from '../../core/src/project.js';
import { architectContext, type ArchitectRequest, architectTaskKey } from './architect.js';
import { CliUsageError } from './cliErrors.js';
import { readTaskInput, taskPath } from './commands/taskFiles.js';
import { withoutOperatorToken } from './featureIngress.js';
import {
  materializeStackAdr,
  requireProjectStack,
  stackAdr,
  stackArtifactRoot,
  stackDecision,
} from './projectStack.js';
import { requirementsDocPath } from './requirements.js';
import type { WorkStore } from './workstore/WorkStore.js';

/** Gate before acquiring an architecture lease, slot or Execution. */
export function prepareArchitectureTask(store: WorkStore, key: string): void {
  requireProjectStack(store, key);
  const task = architectTaskKey(key);
  const existing = store.getTask(task);
  if (existing && (existing.agent_role !== 'architect' || existing.type !== 'architecture'))
    throw new CliUsageError('Design task belongs to another workflow');
  if (!existing) store.createTask({ key: task, type: 'architecture', agent_role: 'architect' });
}

/** Consume only our exact untracked projection before the worker's clean-tree check.
 * Architect publishes it with the design through the existing artifact transaction. */
export function prepareArchitectureWorktree(
  store: WorkStore,
  config: ProjectConfig,
  key: string,
  cwd: string,
): void {
  requireProjectStack(store, key);
  if (cwd !== stackArtifactRoot(store, config, key)) throw new Error('Architect worktree changed');
  const decision = stackDecision(store, key)!;
  const relative = decision.projectStack!.adrPath;
  const file = taskPath(cwd, relative);
  if (!fs.existsSync(file)) return;
  const tracked = execFileSync('git', ['ls-files', '--', relative], {
    cwd,
    env: withoutOperatorToken(process.env),
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  if (tracked || readTaskInput(cwd, relative) !== stackAdr(decision))
    throw new Error('Stack ADR changed before Architect publication');
  fs.unlinkSync(file);
}

/** Failed/interrupted proposals retain the accepted ADR without rerunning a model. */
export function restoreArchitectureWorktree(
  store: WorkStore,
  config: ProjectConfig,
  key: string,
): void {
  const decision = stackDecision(store, key);
  if (decision) materializeStackAdr(config, decision, store);
}

/** Single launch gate for every Architect entry, including direct worker calls. */
export function architectureContext(
  store: WorkStore,
  config: ProjectConfig,
  input: ArchitectRequest,
  cwd: string,
  base: string,
): Record<string, string | null> {
  const approved = store.getFeature(input.key);
  if (approved?.status !== 'approved' || approved.git_sha !== input.gitSha || base !== input.gitSha)
    throw new Error('Approved FeatureSpec SHA changed before Architect launch');
  const relative = requirementsDocPath(config.project.brain.path, input.key);
  const source = execFileSync('git', ['show', `${input.gitSha}:${relative}`], {
    cwd,
    env: withoutOperatorToken(process.env),
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  if (source !== readTaskInput(cwd, relative).trim())
    throw new Error('Approved FeatureSpec file changed before Architect launch');
  return {
    ...architectContext(cwd, config.project.brain.path),
    'STACK.md': requireProjectStack(store, input.key),
  };
}
