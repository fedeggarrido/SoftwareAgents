import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  IdeaErrorCode,
  IdeasSnapshot,
  IdeaSummary,
  SubmitIdeaResult,
} from '../../core/src/messages.js';
import { AuditLog } from './auditLog.js';
import { readTaskInput, taskDirectory, taskPath } from './commands/taskFiles.js';
import { companyWorkspaceRoot } from './companyControl.js';
import {
  FEATURE_ID_DIGITS,
  FEATURE_ID_MAX,
  FEATURE_ID_MIN,
  FEATURE_IDEA_RESERVATIONS_DIRECTORY,
  FEATURE_IDEAS_DIRECTORY,
  TASK_CLI_INPUT_BYTES,
} from './constants.js';
import { loadProjectConfig } from './projectConfig.js';
import { gitCommonDir, openReadOnlyWorkStore } from './workstore/readOnlyWorkStore.js';

class IdeaFailure extends Error {
  constructor(readonly code: IdeaErrorCode) {
    super(code);
  }
}
const fail = (code: IdeaErrorCode): never => {
  throw new IdeaFailure(code);
};
const failureCode = (error: unknown): IdeaErrorCode =>
  error instanceof IdeaFailure ? error.code : 'unavailable';

function preparedProject(root: string | undefined) {
  if (!root) return fail('no_project');
  try {
    taskPath(root, '.softwareagents/project.yaml');
    const config = loadProjectConfig(root);
    if (!config) return fail('missing_manifest');
    return config;
  } catch (error) {
    if (error instanceof IdeaFailure) throw error;
    return fail('invalid_manifest');
  }
}

function ideaDirectory(projectId: string): string {
  return `${FEATURE_IDEAS_DIRECTORY}/${projectId}`;
}

function summary(key: string, projectId: string): IdeaSummary {
  // Only server-generated identifiers and a fixed relative path enter this command.
  return {
    key,
    command: `pixel-agents feature run ${key} --request ${ideaDirectory(projectId)}/${key}.md --confirm`,
  };
}

/** Missing WorkStore is normal before the first feature. Existing unreadable stores fail closed. */
function featureKeys(root: string, projectId: string): Set<string> {
  const file = path.join(gitCommonDir(root), 'softwareagents/work.sqlite3');
  if (!fs.existsSync(file)) return new Set();
  const db = openReadOnlyWorkStore(root);
  try {
    return new Set(
      db
        .prepare('SELECT key FROM features WHERE project_id = ?')
        .all(projectId)
        .map((row) => {
          if (typeof row.key !== 'string' || !/^FEAT-\d{3}$/.test(row.key))
            return fail('unavailable');
          return row.key;
        }),
    );
  } finally {
    db.close();
  }
}

function ideaKeys(root: string, projectId: string): string[] {
  try {
    const relative = ideaDirectory(projectId);
    const directory = taskPath(root, relative);
    if (!fs.existsSync(directory)) return [];
    return fs
      .readdirSync(directory)
      .flatMap((name) => {
        const match = /^(FEAT-\d{3})\.md$/.exec(name);
        if (!match) return [];
        const file = taskPath(root, `${relative}/${name}`);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.nlink !== 1) return fail('unsafe_storage');
        return [match[1]];
      })
      .sort();
  } catch {
    return fail('unsafe_storage');
  }
}

/** Also reserve FeatureSpec files that have not yet been registered in WorkStore. */
function artifactKeys(root: string, brain: string): string[] {
  const directory = taskPath(root, `${brain}/features`);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).flatMap((name) => {
    const match = /^(FEAT-\d{3})\.ya?ml$/.exec(name);
    return match ? [match[1]] : [];
  });
}

/** Empty, durable reservations coordinate offices in different linked checkouts too.
 * A crash can strand a reservation; never steal it while a writer may still be alive.
 */
function reserveId(common: string, directory: string, key: string): boolean {
  try {
    const file = taskPath(common, `${directory}/${key}`);
    let fd: number;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = fs.lstatSync(taskPath(common, `${directory}/${key}`));
      if (!stat.isFile() || stat.nlink !== 1) return fail('unsafe_storage');
      return false;
    }
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return fail('unsafe_storage');
  }
}

export function readIdeas(
  requestId: string,
  privileged: boolean,
  root = companyWorkspaceRoot(),
): IdeasSnapshot {
  const base: IdeasSnapshot = {
    type: 'ideasSnapshot',
    requestId,
    projectId: null,
    canSubmit: false,
    errorCode: null,
    ideas: [],
  };
  // No Project/config/filesystem probe before checking the connection capability.
  if (!privileged) return { ...base, errorCode: 'denied' };
  try {
    const config = preparedProject(root);
    base.projectId = config.project.id;
    const used = featureKeys(config.repoRoot, config.project.id);
    const ideas = ideaKeys(config.repoRoot, config.project.id)
      .filter((key) => !used.has(key))
      .map((key) => summary(key, config.project.id));
    return { ...base, canSubmit: true, ideas };
  } catch (error) {
    return { ...base, errorCode: failureCode(error) };
  }
}

export function submitIdea(
  request: { requestId: string; projectId: string; text: unknown },
  privileged: boolean,
  root = companyWorkspaceRoot(),
): SubmitIdeaResult {
  const base: SubmitIdeaResult = {
    type: 'submitIdeaResult',
    requestId: request.requestId,
    projectId: request.projectId,
    status: 'rejected',
    errorCode: null,
    idea: null,
  };
  if (!privileged) return { ...base, errorCode: 'denied' };
  if (typeof request.text !== 'string') return { ...base, errorCode: 'invalid_request' };
  if (Buffer.byteLength(request.text, 'utf8') > TASK_CLI_INPUT_BYTES)
    return { ...base, errorCode: 'too_large' };
  if (!request.text.trim()) return { ...base, errorCode: 'empty_text' };
  if (Buffer.from(request.text, 'utf8').toString('utf8') !== request.text)
    return { ...base, errorCode: 'invalid_request' };
  try {
    const config = preparedProject(root);
    if (request.projectId !== config.project.id) return { ...base, errorCode: 'unknown_project' };
    const used = featureKeys(config.repoRoot, config.project.id);
    for (const key of artifactKeys(config.repoRoot, config.project.brain.path)) used.add(key);
    for (const key of ideaKeys(config.repoRoot, config.project.id)) used.add(key);
    const directory = ideaDirectory(config.project.id);
    const common = gitCommonDir(config.repoRoot);
    const reservations = `${FEATURE_IDEA_RESERVATIONS_DIRECTORY}/${config.project.id}`;
    try {
      taskDirectory(config.repoRoot, directory);
      taskDirectory(common, reservations);
    } catch {
      return fail('unsafe_storage');
    }
    for (let id = FEATURE_ID_MIN; id <= FEATURE_ID_MAX; id++) {
      const key = `FEAT-${String(id).padStart(FEATURE_ID_DIGITS, '0')}`;
      if (used.has(key)) continue;
      if (!reserveId(common, reservations, key)) continue;
      const relative = `${directory}/${key}.md`;
      const file = taskPath(config.repoRoot, relative);
      let fd: number;
      try {
        // Separate exclusive creation in the checkout never overwrites an existing
        // entry (including a tracked file, symlink or junction).
        fd = fs.openSync(file, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          ideaKeys(config.repoRoot, config.project.id); // Refuse links introduced by another writer.
          continue;
        }
        throw error;
      }
      try {
        if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).nlink !== 1)
          return fail('unsafe_storage');
        fs.writeFileSync(fd, request.text, 'utf8');
        fs.fsyncSync(fd);
      } catch (error) {
        // Remove only our own failed exclusive creation, never a replacement entry.
        const owned = fs.fstatSync(fd);
        try {
          const current = fs.lstatSync(taskPath(config.repoRoot, relative));
          if (current.isFile() && current.ino === owned.ino && current.dev === owned.dev)
            fs.unlinkSync(file);
        } catch {
          // Filesystem failure: retain the reservation rather than touch another file.
        }
        throw error;
      } finally {
        fs.closeSync(fd);
      }
      // Exercise exactly the CLI's reader, with the unchanged text and byte limit.
      if (readTaskInput(config.repoRoot, relative) !== request.text) return fail('unsafe_storage');
      const idea = summary(key, config.project.id);
      const ideaHash = createHash('sha256').update(request.text).digest('hex');
      try {
        new AuditLog().append({
          projectId: config.project.id,
          action: 'save_feature_idea',
          resourceType: 'feature_idea',
          resourceId: key,
          actorType: 'human',
          actorId: 'operator',
          policyDecision: null,
          riskLevel: 'low',
          taskKey: null,
          executionId: null,
          outcome: { status: 'saved', detail: JSON.stringify({ ideaHash }) },
        });
      } catch {
        // Persisted draft remains saved: retrying would create a second idea.
        return { ...base, status: 'saved', errorCode: 'audit_failed', idea };
      }
      return { ...base, status: 'saved', idea };
    }
    return fail('ids_exhausted');
  } catch (error) {
    return { ...base, status: 'failed', errorCode: failureCode(error) };
  }
}

/** Shared protocol boundary; VS Code has no Project selection contract for this control. */
export function handleIdeaMessage(
  msg: Record<string, unknown>,
  send: (message: Record<string, unknown>) => void,
  privileged: boolean,
  supported = true,
): void {
  if (typeof msg.requestId !== 'string') return;
  if (msg.type === 'requestIdeas') {
    send({
      ...(supported
        ? readIdeas(msg.requestId, privileged)
        : ({
            type: 'ideasSnapshot',
            requestId: msg.requestId,
            projectId: null,
            canSubmit: false,
            errorCode: 'unsupported_adapter',
            ideas: [],
          } satisfies IdeasSnapshot)),
    });
  } else if (msg.type === 'submitIdea' && typeof msg.projectId === 'string') {
    const allowedKeys = ['type', 'requestId', 'projectId', 'text'];
    const result =
      !privileged || !supported || Object.keys(msg).some((key) => !allowedKeys.includes(key))
        ? ({
            type: 'submitIdeaResult',
            requestId: msg.requestId,
            projectId: msg.projectId,
            status: 'rejected',
            errorCode: !privileged
              ? 'denied'
              : !supported
                ? 'unsupported_adapter'
                : 'invalid_request',
            idea: null,
          } satisfies SubmitIdeaResult)
        : submitIdea(
            { requestId: msg.requestId, projectId: msg.projectId, text: msg.text },
            privileged,
          );
    send({ ...result });
  }
}
