import * as path from 'path';

import type { CharacterDetail } from '../../core/src/messages.js';
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
  const row = readRows<Row>(
    file,
    `SELECT t.project_id, t.key AS task_key, t.status,
    t.branch, t.worktree_ref, t.pr_ref,
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
function text(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : CHARACTER_DETAIL_UNKNOWN;
}

/** Explicit display projection; never serialize a row, declaration, reason or actor. */
export function projectCharacterDetail(row: Row, now = Date.now()): CharacterDetail {
  const start = typeof row.started_at === 'string' ? Date.parse(row.started_at) : NaN;
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
      .replace(/(?:sk-|ghp_|github_pat_)[a-z0-9_-]+/gi, '[redacted]'),
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
        : path.basename(String(row.worktree_ref).replace(/[\\/]+$/, '')),
    branch: text(row.branch),
    pr: text(row.pr_ref),
    selectionReason: text(row.selection_reason),
    // The role's permission ceiling (ROLE_PROFILES); a template can only narrow it.
    permissions: Object.hasOwn(ROLE_PROFILES, String(row.execution_role))
      ? `${ROLE_PROFILES[String(row.execution_role) as keyof typeof ROLE_PROFILES]} (techo del rol)`
      : CHARACTER_DETAIL_UNKNOWN,
    log: text(row.log),
  };
}
