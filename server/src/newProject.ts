import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  CreateNewProject,
  NewProjectOptions,
  NewProjectResult,
  NewProjectValidation,
  ProjectDirectories,
  ValidateNewProject,
} from '../../core/src/messages.js';
import {
  projectNameProposals,
  projectSlug,
  validProjectName,
  validProjectSlug,
} from '../../core/src/projectNaming.js';
import { readTaskInput, taskPath } from './commands/taskFiles.js';
import { companyWorkspaceRoot } from './companyControl.js';
import type { ConfigNamespace } from './configPersistence.js';
import {
  readConfig,
  readRawConfig,
  withConfigLock,
  writeRawConfigFile,
} from './configPersistence.js';
import { FEATURE_IDEAS_DIRECTORY, PROJECT_MANIFEST_PATH } from './constants.js';
import { evalGit } from './evalTasks.js';
import { featureIngressActor } from './featureIngress.js';
import {
  checkProjectCapacity,
  failNewProject,
  NewProjectFailure,
  optionalEntry,
  projectDirectory,
  requireProjectDirectory,
} from './newProjectPaths.js';
import { loadProjectConfig } from './projectConfig.js';
import { prepareProject, projectRepositoryRoot } from './projectPreparation.js';

type ProjectRequest = ValidateNewProject | CreateNewProject;
type Send = (message: Record<string, unknown>) => void;

function defaultParent(namespace: ConfigNamespace): string {
  return requireProjectDirectory(readConfig()[namespace].projectsParentDirectory || os.homedir());
}

function projectContext(): string {
  const root = companyWorkspaceRoot();
  if (!root) return '';
  const config = loadProjectConfig(root);
  if (!config) return path.basename(root);
  const relative = `${FEATURE_IDEAS_DIRECTORY}/${config.project.id}`;
  const directory = taskPath(root, relative);
  if (!optionalEntry(directory)) return config.project.name;
  const latest = fs
    .readdirSync(directory)
    .filter((name) => /^FEAT-\d{3}\.md$/.test(name))
    .map((name) => ({
      name,
      stat: fs.lstatSync(taskPath(root, `${relative}/${name}`)),
    }))
    .sort(
      (left, right) =>
        right.stat.mtimeMs - left.stat.mtimeMs || right.name.localeCompare(left.name),
    )[0];
  if (!latest) return config.project.name;
  if (!latest.stat.isFile() || latest.stat.nlink !== 1) return failNewProject('unsafe_path');
  const text = readTaskInput(root, `${relative}/${latest.name}`);
  // The canonical draft separates the original idea from the interview answers.
  return text.split('\n## Respuestas\n')[0].replace(/^# Idea\s*/, '');
}

function parseRequest(msg: Record<string, unknown>): ProjectRequest {
  if (
    Object.keys(msg).some(
      (key) => !['type', 'requestId', 'name', 'parentPath', 'folderMode', 'hosting'].includes(key),
    ) ||
    (msg.type !== 'validateNewProject' && msg.type !== 'createNewProject') ||
    typeof msg.requestId !== 'string' ||
    typeof msg.name !== 'string' ||
    typeof msg.parentPath !== 'string' ||
    (msg.folderMode !== 'create' && msg.folderMode !== 'existing') ||
    (msg.hosting !== 'local' && msg.hosting !== 'github_private')
  )
    return failNewProject('invalid_request');
  if (!validProjectName(msg.name) || !validProjectSlug(projectSlug(msg.name)))
    return failNewProject('invalid_request');
  return {
    type: msg.type,
    requestId: msg.requestId,
    name: msg.name,
    parentPath: msg.parentPath,
    folderMode: msg.folderMode,
    hosting: msg.hosting,
  };
}

function validateDestination(request: ProjectRequest) {
  const slug = projectSlug(request.name);
  const parent = requireProjectDirectory(request.parentPath);
  const target =
    request.folderMode === 'existing' ? parent : projectDirectory(path.join(parent, slug));
  const entry = optionalEntry(target);
  if (entry && !entry.isDirectory()) return failNewProject('not_directory');
  let config = null;
  try {
    if (entry) taskPath(target, PROJECT_MANIFEST_PATH);
    config = entry ? loadProjectConfig(target) : null;
  } catch {
    return failNewProject('conflicting_project');
  }
  if (config && config.project.name !== request.name.trim())
    return failNewProject('conflicting_project');
  if (entry) {
    const contents = fs.readdirSync(target);
    const git = optionalEntry(taskPath(target, '.git'));
    if (request.folderMode === 'create' && contents.length)
      return failNewProject(git || config ? 'existing_available' : 'not_empty');
    if (request.folderMode === 'existing' && contents.length && !git)
      return failNewProject('not_empty');
    if (config && projectRepositoryRoot(target) !== target)
      return failNewProject('conflicting_project');
  }
  checkProjectCapacity(entry ? target : parent);
  return { target, entry, config };
}

function browse(msg: Record<string, unknown>, namespace: ConfigNamespace): ProjectDirectories {
  if (
    Object.keys(msg).some((key) => !['type', 'requestId', 'path', 'purpose'].includes(key)) ||
    (msg.path !== undefined && typeof msg.path !== 'string') ||
    (msg.purpose !== 'browse' && msg.purpose !== 'save_default')
  )
    return failNewProject('invalid_request');
  const directory = requireProjectDirectory(
    typeof msg.path === 'string' ? msg.path : defaultParent(namespace),
  );
  if (msg.purpose === 'save_default') {
    checkProjectCapacity(directory);
    withConfigLock(() => {
      const config = readRawConfig() ?? {};
      const settings = config[namespace];
      if (
        settings !== undefined &&
        (!settings || typeof settings !== 'object' || Array.isArray(settings))
      )
        return failNewProject('unavailable');
      writeRawConfigFile({
        ...config,
        [namespace]: { ...settings, projectsParentDirectory: directory },
      });
    });
  }
  const directories = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && !entry.isSymbolicLink() && entry.name.toLowerCase() !== '.git',
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  return {
    type: 'projectDirectories',
    requestId: String(msg.requestId),
    path: directory,
    parent: path.dirname(directory) === directory ? null : path.dirname(directory),
    directories,
    errorCode: null,
  };
}

/** Every disk operation is downstream of BOTH server-owned human ingress and connection privilege. */
export function handleNewProjectMessage(
  msg: Record<string, unknown>,
  send: Send,
  privileged: boolean,
  namespace: ConfigNamespace = 'standalone',
  onCreated?: (root: string) => void,
): void {
  if (typeof msg.requestId !== 'string') return;
  let reply: NewProjectOptions | ProjectDirectories | NewProjectResult | NewProjectValidation;
  switch (msg.type) {
    case 'requestNewProject':
      reply = {
        type: 'newProjectOptions',
        requestId: msg.requestId,
        proposals: [],
        defaultParent: null,
        errorCode: null,
      };
      break;
    case 'browseProjectDirectories':
      reply = {
        type: 'projectDirectories',
        requestId: msg.requestId,
        path: null,
        parent: null,
        directories: [],
        errorCode: null,
      };
      break;
    case 'validateNewProject':
    case 'createNewProject':
      reply = {
        type: msg.type === 'createNewProject' ? 'newProjectResult' : 'newProjectValidation',
        requestId: msg.requestId,
        path: null,
        projectId: null,
        hosting: msg.hosting === 'github_private' ? 'github_private' : 'local',
        status: 'rejected',
        errorCode: null,
      };
      break;
    default:
      return;
  }
  try {
    if (!privileged || featureIngressActor() !== 'human') return failNewProject('denied');
    if (reply.type === 'newProjectOptions') {
      if (Object.keys(msg).some((key) => !['type', 'requestId'].includes(key)))
        return failNewProject('invalid_request');
      reply.defaultParent = defaultParent(namespace);
      reply.proposals = projectNameProposals(projectContext());
    } else if (reply.type === 'projectDirectories') reply = browse(msg, namespace);
    else {
      const request = parseRequest(msg);
      // Report a normalised candidate even when validation offers adoption.
      reply.path =
        request.folderMode === 'existing'
          ? projectDirectory(request.parentPath)
          : projectDirectory(
              path.join(projectDirectory(request.parentPath), projectSlug(request.name)),
            );
      const { target, entry, config } = validateDestination(request);
      reply.path = target;
      reply.projectId = config?.project.id ?? null;
      reply.status = 'ready';
      if (request.type === 'createNewProject') {
        if (!entry) fs.mkdirSync(target, { mode: 0o700 });
        if (!optionalEntry(taskPath(target, '.git')))
          evalGit(target, ['init', '--quiet', '--initial-branch=main']);
        if (config) reply.projectId = config.project.id;
        else {
          const prepared = prepareProject(target, request.name, privileged);
          if (prepared.status !== 'created') return failNewProject('preparation_failed');
          reply.projectId = prepared.projectId;
          reply.errorCode = prepared.errorCode === 'audit_failed' ? 'audit_failed' : null;
        }
        reply.status = 'created';
        try {
          onCreated?.(target);
        } catch {
          reply.errorCode = 'binding_failed';
        }
      }
    }
  } catch (error) {
    reply.errorCode = error instanceof NewProjectFailure ? error.code : 'unavailable';
    if ('status' in reply && reply.status !== 'created') reply.status = 'rejected';
    if (reply.errorCode === 'denied' && 'path' in reply) reply.path = null;
  }
  send({ ...reply });
}
