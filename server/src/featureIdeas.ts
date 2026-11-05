import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { IDEA_ASSUMPTION_TEXT, IDEA_QUESTIONS } from '../../core/src/ideaInterview.js';
import type {
  IdeaAnswer,
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
import { evalGit } from './evalTasks.js';
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

function validateAnswers(value: unknown): IdeaAnswer[] {
  if (!Array.isArray(value) || value.length !== IDEA_QUESTIONS.length)
    return fail('invalid_request');
  const seen = new Set<string>();
  for (const answer of value) {
    if (
      !answer ||
      typeof answer !== 'object' ||
      Object.keys(answer).some((key) => !['questionId', 'choice', 'text'].includes(key)) ||
      !IDEA_QUESTIONS.some((question) => question.id === answer.questionId) ||
      seen.has(answer.questionId) ||
      typeof answer.text !== 'string' ||
      !['answer', 'decide'].includes(answer.choice)
    )
      return fail('invalid_request');
    seen.add(answer.questionId);
    if (
      (answer.choice === 'answer' && !answer.text.trim()) ||
      (answer.choice === 'decide' && answer.text !== '') ||
      Buffer.from(answer.text, 'utf8').toString('utf8') !== answer.text
    )
      return fail('invalid_request');
    if (Buffer.byteLength(answer.text, 'utf8') > TASK_CLI_INPUT_BYTES) return fail('too_large');
  }
  return value;
}

/** Indent every untrusted line, including CR-only lines, as literal Markdown code. */
function literalMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function interviewMarkdown(text: string, answers: IdeaAnswer[]): string {
  const answered: string[] = [];
  const assumptions: string[] = [];
  for (const question of IDEA_QUESTIONS) {
    const answer = answers.find((entry) => entry.questionId === question.id)!;
    const heading = `### ${question.label}\n\n`;
    if (answer.choice === 'decide') assumptions.push(`${heading}${IDEA_ASSUMPTION_TEXT}`);
    else answered.push(`${heading}${literalMarkdown(answer.text)}`);
  }
  return `# Idea\n\n${literalMarkdown(text)}\n\n## Respuestas\n\n${answered.join('\n\n') || 'Ninguna.'}\n\n## Supuestos\n\n${assumptions.join('\n\n') || 'Ninguno.'}\n`;
}

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
        .prepare(
          `SELECT key FROM features WHERE project_id = ?
          UNION SELECT feature_key AS key FROM feature_runs WHERE project_id = ?
          UNION SELECT substr(key, 1, 8) AS key FROM tasks WHERE project_id = ?
            AND (key GLOB 'FEAT-[0-9][0-9][0-9]' OR key GLOB 'FEAT-[0-9][0-9][0-9]-*')
          UNION SELECT feature_key AS key FROM tasks WHERE project_id = ? AND feature_key IS NOT NULL`,
        )
        .all(projectId, projectId, projectId, projectId)
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
  return [`${brain}/features`, `${brain}/features/requests`].flatMap((relative) => {
    const directory = taskPath(root, relative);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).flatMap((name) => {
      const match = /^(FEAT-\d{3})\.(?:ya?ml|md)$/.exec(name);
      return match ? [match[1]] : [];
    });
  });
}

/** Read this checkout's index, including paths deleted from disk and sparse entries. */
function trackedIdeaKeys(root: string, directory: string): string[] {
  return evalGit(root, [
    '-c',
    'core.fsmonitor=false',
    'ls-files',
    '--cached',
    '-z',
    '--',
    // The index is case-sensitive even where the filesystem is not (Windows).
    `:(icase)${directory}`,
  ])
    .split('\0')
    .flatMap((file) => {
      const match = /(?:^|\/)(FEAT-\d{3})\.md(?:\/|$)/i.exec(file);
      return match ? [match[1].toUpperCase()] : [];
    });
}

/** Existing runtime branches remain occupied even when their WorkStore row is absent. */
function branchKeys(root: string): string[] {
  return evalGit(root, ['for-each-ref', '--format=%(refname)', 'refs/heads/sa/FEAT-*'])
    .split('\n')
    .flatMap((ref) => {
      const match = /^refs\/heads\/sa\/(FEAT-\d{3})(?:$|-)/.exec(ref);
      return match ? [match[1]] : [];
    });
}

/** Local-only exclusion. Failure is reported without exposing filesystem diagnostics. */
function excludeIdeas(common: string): void {
  try {
    taskDirectory(common, 'info');
    const file = taskPath(common, 'info/exclude');
    let previous = '';
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1) return fail('unsafe_storage');
      previous = fs.readFileSync(file, 'utf8');
    }
    const rule = `/${FEATURE_IDEAS_DIRECTORY}/`;
    if (previous.split(/\r?\n/).includes(rule)) return;
    fs.appendFileSync(file, `${previous && !previous.endsWith('\n') ? '\n' : ''}${rule}\n`, {
      mode: 0o600,
    });
  } catch {
    console.warn('[featureIdeas] Local Git exclusion unavailable. Drafts can still be saved.');
  }
}

interface OwnedFile {
  file: string;
  stat: fs.Stats;
}

/** Never remove a replacement entry. Failed cleanup leaves owner metadata for inspection. */
function removeOwned(root: string, relative: string, owned: OwnedFile): boolean {
  try {
    const current = fs.lstatSync(taskPath(root, relative));
    if (!current.isFile() || current.ino !== owned.stat.ino || current.dev !== owned.stat.dev)
      return false;
    fs.unlinkSync(owned.file);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** Durable, inspectable reservations coordinate linked checkouts. Never steal a crash's id. */
function reserveId(common: string, relative: string, metadata: object): OwnedFile | null {
  try {
    const file = taskPath(common, relative);
    let fd: number;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = fs.lstatSync(taskPath(common, relative));
      if (!stat.isFile() || stat.nlink !== 1) return fail('unsafe_storage');
      return null;
    }
    const owned = { file, stat: fs.fstatSync(fd) };
    try {
      fs.writeFileSync(fd, JSON.stringify(metadata), 'utf8');
      fs.fsyncSync(fd);
    } catch (error) {
      removeOwned(common, relative, owned);
      throw error;
    } finally {
      fs.closeSync(fd);
    }
    return owned;
  } catch {
    return fail('unsafe_storage');
  }
}

function publishIdea(root: string, relative: string, staging: string, text: string): void {
  const file = taskPath(root, staging);
  const fd = fs.openSync(file, 'wx', 0o600);
  const owned = { file, stat: fs.fstatSync(fd) };
  try {
    try {
      if (!owned.stat.isFile() || owned.stat.nlink !== 1) return fail('unsafe_storage');
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (readTaskInput(root, staging) !== text) return fail('unsafe_storage');
    // Resolve again immediately before publication, including the existing staging file.
    const real = fs.realpathSync.native(file);
    if (taskPath(root, staging) !== real) return fail('unsafe_storage');
    const current = fs.lstatSync(real);
    if (current.ino !== owned.stat.ino || current.dev !== owned.stat.dev || current.nlink !== 1)
      return fail('unsafe_storage');
    // link is atomic and fails with EEXIST. rename would overwrite on POSIX.
    fs.linkSync(real, taskPath(root, relative));
  } finally {
    removeOwned(root, staging, owned);
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
  request: { requestId: string; projectId: string; text: unknown; answers: unknown },
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
  let markdown: string;
  try {
    markdown = interviewMarkdown(request.text, validateAnswers(request.answers));
    if (Buffer.byteLength(markdown, 'utf8') > TASK_CLI_INPUT_BYTES) return fail('too_large');
  } catch (error) {
    return { ...base, errorCode: failureCode(error) };
  }
  try {
    const config = preparedProject(root);
    if (request.projectId !== config.project.id) return { ...base, errorCode: 'unknown_project' };
    const used = featureKeys(config.repoRoot, config.project.id);
    for (const key of artifactKeys(config.repoRoot, config.project.brain.path)) used.add(key);
    for (const key of ideaKeys(config.repoRoot, config.project.id)) used.add(key);
    const directory = ideaDirectory(config.project.id);
    for (const key of trackedIdeaKeys(config.repoRoot, directory)) used.add(key);
    for (const key of branchKeys(config.repoRoot)) used.add(key);
    const common = gitCommonDir(config.repoRoot);
    excludeIdeas(common);
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
      const relative = `${directory}/${key}.md`;
      const owner = randomUUID();
      const staging = `${directory}/.${key}-${owner}.stage`;
      const reservationPath = `${reservations}/${key}`;
      const reservation = reserveId(common, reservationPath, {
        owner,
        pid: process.pid,
        createdAt: new Date().toISOString(),
        checkout: config.repoRoot,
        staging,
        destination: relative,
      });
      if (!reservation) continue;
      try {
        publishIdea(config.repoRoot, relative, staging, markdown);
      } catch (error) {
        removeOwned(common, reservationPath, reservation);
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          ideaKeys(config.repoRoot, config.project.id); // Refuse links introduced by another writer.
          continue;
        }
        throw error;
      }
      const idea = summary(key, config.project.id);
      const ideaHash = createHash('sha256').update(markdown).digest('hex');
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
    const allowedKeys = ['type', 'requestId', 'projectId', 'text', 'answers'];
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
            {
              requestId: msg.requestId,
              projectId: msg.projectId,
              text: msg.text,
              answers: msg.answers,
            },
            privileged,
          );
    send({ ...result });
  }
}
