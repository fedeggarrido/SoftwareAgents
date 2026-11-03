import type { CharacterDetail, PullRequestStatus } from '../../core/src/messages.js';
import { ROLE_PROFILES } from './agentCompiler.js';
import { CHARACTER_DETAIL_SECOND_MS, CHARACTER_DETAIL_UNKNOWN } from './constants.js';
import { readRows } from './sqliteReadOnly.js';

type Row = Record<string, unknown>;
/** Read-only, project-scoped lookup. SQL extracts a title, never a full declaration. */
export function readCharacterDetail(
  file: string,
  project: string,
  task: string,
  session: string,
): CharacterDetail | undefined {
  const hasPrStatus = readRows<{ name: string }>(file, 'PRAGMA table_info(tasks)')?.some(
    (column) => column.name === 'pr_status',
  );
  const row = readRows<Row>(
    file,
    `SELECT t.project_id, t.key AS task_key, t.status,
    t.branch, t.worktree_ref, t.pr_ref, ${hasPrStatus ? 't.pr_status' : 'NULL AS pr_status'},
    CASE WHEN json_valid(t.declaration) THEN json_extract(t.declaration, '$.title') END AS task_title,
    e.agent_role AS execution_role, e.agent_template_version, e.executor, e.model_id,
    e.model_tier, e.model_effort, e.selection_reason, e.started_at
    FROM tasks t LEFT JOIN executions e ON e.project_id = t.project_id AND e.task_key = t.key
      AND e.session_id = ? AND e.key = (SELECT key FROM executions
        WHERE project_id = t.project_id AND task_key = t.key AND session_id = ?
        ORDER BY started_at DESC, key DESC LIMIT 1)
    WHERE t.project_id = ? AND t.key = ?`,
    session,
    session,
    project,
    task,
  )?.[0];
  return row ? projectCharacterDetail(row) : undefined;
}
/** Last path segment for Windows or POSIX paths, whatever platform the server runs on. */
function fileName(value: string): string {
  return (
    value
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || CHARACTER_DETAIL_UNKNOWN
  );
}
function text(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : CHARACTER_DETAIL_UNKNOWN;
}

/** Explicit display projection; never serialize a row, declaration, reason or actor. */
export function projectCharacterDetail(row: Row, now = Date.now()): CharacterDetail {
  const start = typeof row.started_at === 'string' ? Date.parse(row.started_at) : NaN;
  let pr: PullRequestStatus | undefined;
  try {
    pr = typeof row.pr_status === 'string' ? JSON.parse(row.pr_status) : undefined;
    if (pr?.ref !== row.pr_ref) pr = undefined;
  } catch {
    // Corrupt optional metadata cannot hide the other recorded facts.
  }
  return {
    projectId: text(row.project_id),
    // Platform templates are named after their role (agents/templates/<role>.yaml).
    spec:
      text(row.agent_template_version) === CHARACTER_DETAIL_UNKNOWN ||
      text(row.execution_role) === CHARACTER_DETAIL_UNKNOWN
        ? CHARACTER_DETAIL_UNKNOWN
        : `${text(row.execution_role)}@${text(row.agent_template_version)}`,
    role: text(row.execution_role),
    taskKey: text(row.task_key),
    taskTitle: text(row.task_title)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/(?:https?:\/\/|[a-z]:[\\/]|(?<![<\w])\/)[^\s<>]+/gi, '[redacted]')
      .replace(/(?:sk-|ghp_|github_pat_)[a-z0-9_-]+/gi, '[redacted]')
      // key=value secrets, AWS access keys and long opaque tokens (hex/base64).
      .replace(
        /\b(?:token|secret|password|passwd|pwd|api[_-]?key|auth)\s*[=:]\s*\S+/gi,
        '[redacted]',
      )
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]')
      .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '[redacted]'),
    taskStatus: text(row.status),
    executor: text(row.executor),
    model: text(row.model_id),
    tier: text(row.model_tier),
    effort: text(row.model_effort),
    elapsed:
      row.status === 'RUNNING' && Number.isFinite(start) && now >= start
        ? `${Math.floor((now - start) / CHARACTER_DETAIL_SECOND_MS)} s`
        : CHARACTER_DETAIL_UNKNOWN,
    // Name only: an absolute path would expose the operator's home in the office.
    worktree:
      text(row.worktree_ref) === CHARACTER_DETAIL_UNKNOWN
        ? CHARACTER_DETAIL_UNKNOWN
        : fileName(String(row.worktree_ref)),
    branch: text(row.branch),
    pr: text(row.pr_ref),
    prState: pr
      ? `${pr.state}${pr.isDraft ? ' (draft)' : ''}${pr.reviewDecision ? ` · ${pr.reviewDecision}` : ''}`
      : CHARACTER_DETAIL_UNKNOWN,
    ciState: pr
      ? `${pr.ci}${pr.failedChecks.length ? ` · ${pr.failedChecks.join(', ')}` : ''}`
      : CHARACTER_DETAIL_UNKNOWN,
    selectionReason: text(row.selection_reason),
    // The role's permission ceiling (ROLE_PROFILES); a template can only narrow it.
    permissions: Object.hasOwn(ROLE_PROFILES, String(row.execution_role))
      ? `${ROLE_PROFILES[String(row.execution_role) as keyof typeof ROLE_PROFILES]} (techo del rol)`
      : CHARACTER_DETAIL_UNKNOWN,
    // File name only: an absolute path would expose the operator's directories.
    log:
      text(row.log) === CHARACTER_DETAIL_UNKNOWN
        ? CHARACTER_DETAIL_UNKNOWN
        : fileName(String(row.log)),
  };
}
