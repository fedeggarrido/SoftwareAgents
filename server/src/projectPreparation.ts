import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { stringify } from 'yaml';

import type {
  PrepareProjectResult,
  ProjectPreparation,
  ProjectPreparationError,
} from '../../core/src/messages.js';
import type { ProjectManifest } from '../../core/src/project.js';
import { AuditLog } from './auditLog.js';
import { taskPath } from './commands/taskFiles.js';
import { companyWorkspaceRoot } from './companyControl.js';
import { readConfig } from './configPersistence.js';
import {
  PROJECT_BRAIN_PATH,
  PROJECT_FALLBACK_BRANCH,
  PROJECT_ID_HASH_LENGTH,
  PROJECT_ID_SLUG_LENGTH,
  PROJECT_LEGACY_BRANCH,
  PROJECT_LOCAL_REMOTE,
  PROJECT_MANIFEST_PATH,
  PROJECT_NAME_MAX_LENGTH,
} from './constants.js';
import { evalGit } from './evalTasks.js';
import { featureIngressActor } from './featureIngress.js';

export class ProjectPreparationFailure extends Error {
  constructor(readonly code: ProjectPreparationError) {
    super(code);
  }
}

export function projectPreparationError(error: unknown): ProjectPreparationError {
  return error instanceof ProjectPreparationFailure ? error.code : 'unavailable';
}

function reject(code: ProjectPreparationError): never {
  throw new ProjectPreparationFailure(code);
}

function optionalGit(root: string, args: string[]): string {
  try {
    return evalGit(root, args);
  } catch {
    return '';
  }
}

/** Drop URL userinfo, query and fragment before preview, persistence or output. */
function safeRemote(raw: string): string {
  if (!raw) return PROJECT_LOCAL_REMOTE;
  if (/[\u0000-\u0020\u007f\\]/.test(raw) || path.win32.isAbsolute(raw))
    return reject('unsafe_remote');
  const scp = /^(?:[a-zA-Z0-9._-]+@)?([a-zA-Z0-9.-]+):([^\s]+)$/.exec(raw);
  const input = !raw.includes('://') && scp ? `ssh://${scp[1]}/${scp[2]}` : raw;
  try {
    const url = new URL(input);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname)
      return reject('unsafe_remote');
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return reject('unsafe_remote');
  }
}

function assertMissing(root: string): void {
  // Detect every directory entry, including malformed files and dangling links.
  try {
    fs.lstatSync(path.join(root, PROJECT_MANIFEST_PATH));
    return reject('already_exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    taskPath(root, PROJECT_MANIFEST_PATH);
    const brain = taskPath(root, PROJECT_BRAIN_PATH);
    if (fs.existsSync(brain) && !fs.statSync(brain).isDirectory()) return reject('unsafe_storage');
  } catch {
    return reject('unsafe_storage');
  }
}

export function projectRepositoryRoot(cwd: string): string {
  try {
    if (evalGit(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') return reject('not_git');
    return fs.realpathSync.native(evalGit(cwd, ['rev-parse', '--show-toplevel']));
  } catch {
    return reject('not_git');
  }
}

/** Reads Git metadata only. The root is discovered by the server, never supplied by WS. */
export function inspectProjectPreparation(cwd: string, name?: unknown) {
  const root = projectRepositoryRoot(cwd);
  assertMissing(root);
  const folder = path.basename(root);
  const projectName = name === undefined ? folder : name;
  if (
    typeof projectName !== 'string' ||
    !projectName.trim() ||
    projectName.length > PROJECT_NAME_MAX_LENGTH ||
    /[\u0000-\u001f\u007f-\u009f]/.test(projectName) ||
    Buffer.from(projectName, 'utf8').toString('utf8') !== projectName
  )
    return reject('invalid_request');
  const slug =
    folder
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, PROJECT_ID_SLUG_LENGTH)
      .replace(/^-|-$/g, '') || 'project';
  const identity = process.platform === 'win32' ? root.toLowerCase() : root;
  const suffix = createHash('sha256')
    .update(identity)
    .digest('hex')
    .slice(0, PROJECT_ID_HASH_LENGTH);
  const id = `${slug}-${suffix}`;
  // A new manifest must not inherit a pre-existing Operator grant under a reused id.
  if (readConfig().projects[id]) return reject('operator_conflict');
  const originHead = optionalGit(root, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  const defaultBranch =
    originHead.replace(/^origin\//, '') ||
    [PROJECT_FALLBACK_BRANCH, PROJECT_LEGACY_BRANCH].find((branch) =>
      optionalGit(root, ['show-ref', '--verify', `refs/heads/${branch}`]),
    ) ||
    optionalGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']) ||
    PROJECT_FALLBACK_BRANCH;
  const remote = safeRemote(optionalGit(root, ['config', '--get', 'remote.origin.url']));
  const proposal: ProjectPreparation = {
    id,
    name: projectName.trim(),
    defaultBranch,
    remote,
    configPath: PROJECT_MANIFEST_PATH,
    brainPath: PROJECT_BRAIN_PATH,
  };
  const manifest: ProjectManifest = {
    apiVersion: 'softwareagents.io/v1alpha1',
    kind: 'Project',
    id,
    name: proposal.name,
    repo: { remote, defaultBranch },
    brain: { path: PROJECT_BRAIN_PATH },
  };
  return { root, proposal, manifest };
}

function auditCreation(projectId: string, status: 'pending' | 'created'): void {
  new AuditLog().append({
    projectId,
    action: 'prepare_project',
    resourceType: 'project',
    resourceId: projectId,
    actorType: 'human',
    actorId: 'operator',
    policyDecision: null,
    riskLevel: 'low',
    taskKey: null,
    executionId: null,
    outcome: { status },
  });
}

/** Atomic no-replace publication. Same-user hostile path replacement remains an OS boundary. */
function publishManifest(root: string, source: string): void {
  const staging = `${path.posix.dirname(PROJECT_MANIFEST_PATH)}/.project-${randomUUID()}.stage`;
  let staged: fs.Stats | undefined;
  try {
    assertMissing(root);
    for (const relative of [path.posix.dirname(PROJECT_MANIFEST_PATH), PROJECT_BRAIN_PATH]) {
      const target = taskPath(root, relative);
      try {
        fs.mkdirSync(target, { mode: 0o700 });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
          !fs.statSync(taskPath(root, relative)).isDirectory()
        )
          throw error;
      }
    }
    const fd = fs.openSync(taskPath(root, staging), 'wx', 0o600);
    try {
      staged = fs.fstatSync(fd);
      fs.writeFileSync(fd, source, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const stage = taskPath(root, staging);
    const current = fs.lstatSync(stage);
    if (current.ino !== staged.ino || current.dev !== staged.dev || current.nlink !== 1)
      return reject('unsafe_storage');
    assertMissing(root);
    // Unlike rename, hard-link publication can never overwrite an existing entry.
    fs.linkSync(stage, taskPath(root, PROJECT_MANIFEST_PATH));
  } catch (error) {
    if (error instanceof ProjectPreparationFailure) throw error;
    return reject(
      (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'already_exists' : 'unsafe_storage',
    );
  } finally {
    if (staged) {
      try {
        const stage = taskPath(root, staging);
        const current = fs.lstatSync(stage);
        if (current.ino === staged.ino && current.dev === staged.dev) fs.unlinkSync(stage);
      } catch {
        /* Preserve replacements for human inspection. */
      }
    }
    // Preserve directories on failure. Another initializer may already be using the Brain.
  }
}

/** Shared CLI/WS write service. Privilege and managed-process checks precede all probes. */
export function prepareProject(
  cwd: string,
  name: unknown,
  privileged: boolean,
): Omit<PrepareProjectResult, 'type' | 'requestId'> {
  const base = { projectId: null, status: 'rejected' as const, errorCode: null };
  if (!privileged || featureIngressActor() !== 'human') return { ...base, errorCode: 'denied' };
  try {
    const { root, proposal, manifest } = inspectProjectPreparation(cwd, name);
    try {
      auditCreation(proposal.id, 'pending');
    } catch {
      return reject('audit_failed');
    }
    publishManifest(root, stringify(manifest));
    try {
      auditCreation(proposal.id, 'created');
    } catch {
      return { projectId: proposal.id, status: 'created', errorCode: 'audit_failed' };
    }
    return { projectId: proposal.id, status: 'created', errorCode: null };
  } catch (error) {
    return { ...base, errorCode: projectPreparationError(error) };
  }
}

export function handlePrepareProjectMessage(
  msg: Record<string, unknown>,
  send: (message: Record<string, unknown>) => void,
  privileged: boolean,
  supported = true,
  onCreated?: (root: string) => void,
): void {
  if (typeof msg.requestId !== 'string') return;
  const requestId = msg.requestId;
  const reply = (errorCode: ProjectPreparationError) =>
    send({
      type: 'prepareProjectResult',
      requestId,
      projectId: null,
      status: 'rejected',
      errorCode,
    } satisfies PrepareProjectResult);
  if (!privileged || featureIngressActor() !== 'human') return reply('denied');
  if (!supported) return reply('unsupported_adapter');
  if (
    Object.keys(msg).some((key) => !['type', 'requestId', 'name'].includes(key)) ||
    typeof msg.name !== 'string'
  )
    return reply('invalid_request');
  const root = companyWorkspaceRoot();
  if (!root) return reply('not_git');
  const result = prepareProject(root, msg.name, privileged);
  if (result.status === 'created') onCreated?.(projectRepositoryRoot(root));
  send({
    type: 'prepareProjectResult',
    requestId: msg.requestId,
    ...result,
  });
}
