import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { HumanDecision } from '../../core/src/humanDecision.js';
import type { BoardDecision, BoardItem, TaskDetail } from '../../core/src/messages.js';
import { projectPullRequest, projectPullRequestObservation } from '../../core/src/pullRequest.js';
import { taskChangeImpact, taskChangePolicy } from '../../core/src/taskChangePolicy.js';
import { approvedTaskDescription, taskDecisionText } from './taskChangeDecisions.js';

export function taskDeclarationText(declaration: string | null | undefined): {
  title?: string;
  description?: string;
  followUpOf?: string;
} {
  if (!declaration) return {};
  const value: unknown = JSON.parse(declaration);
  if (!value || typeof value !== 'object') throw new Error('Invalid Task declaration');
  return {
    title: 'title' in value && typeof value.title === 'string' ? value.title : undefined,
    description:
      'description' in value && typeof value.description === 'string'
        ? value.description
        : undefined,
    followUpOf:
      'followUpOf' in value && typeof value.followUpOf === 'string' ? value.followUpOf : undefined,
  };
}

export function projectTaskDecision(decision: HumanDecision): BoardDecision {
  return {
    id: decision.id,
    status: decision.status,
    question: taskDecisionText(decision.context),
    options: decision.options.map((option) => option.id),
    structuredOptions: decision.options,
    recommendation: decision.recommendation,
    impact: decision.impact,
    blocks: decision.blocks,
  };
}

/** Caller holds one SQLite snapshot, or the writer fence for confirmation. */
export function projectTaskDetail(db: DatabaseSync, projectId: string, key: string): TaskDetail {
  const tasks = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY key').all(projectId);
  const task = tasks.find((candidate) => candidate.key === key);
  if (!task) throw new Error('Task is unavailable');
  const dependencies = db
    .prepare(
      'SELECT task_key, depends_on_key FROM task_dependencies WHERE project_id = ? ORDER BY task_key, depends_on_key',
    )
    .all(projectId);
  const rows = db
    .prepare(
      'SELECT escalation FROM human_decisions WHERE project_id = ? AND escalation IS NOT NULL ORDER BY key',
    )
    .all(projectId);
  // SAFETY: Escalations are validated HumanDecision JSON at the existing WorkStore ingress.
  const decisions = rows.map((row) => JSON.parse(String(row.escalation)) as HumanDecision);
  const items: BoardItem[] = tasks.map((record) => ({
    id: String(record.key),
    title:
      taskDeclarationText(record.declaration === null ? null : String(record.declaration)).title ??
      String(record.key),
    phase: String(record.status),
    epic: record.feature_key === null ? undefined : String(record.feature_key),
    dependsOn: dependencies
      .filter((dependency) => dependency.task_key === record.key)
      .map((dependency) => String(dependency.depends_on_key)),
    prRef: record.pr_ref === null ? undefined : String(record.pr_ref),
    prStatus: projectPullRequest(record.pr_status === null ? null : String(record.pr_status)),
    prObservation: projectPullRequestObservation(
      record.pr_observation === null ? null : String(record.pr_observation),
    ),
    agentIds: [],
  }));
  const item = items.find((candidate) => candidate.id === key)!;
  const declaration = taskDeclarationText(
    task.declaration === null ? null : String(task.declaration),
  );
  const feature = task.feature_key
    ? db
        .prepare('SELECT title, status, git_sha FROM features WHERE project_id = ? AND key = ?')
        .get(projectId, task.feature_key)
    : undefined;
  const relevant = decisions.filter(
    (decision) =>
      decision.status !== 'answered' &&
      (decision.blocks.includes(key) ||
        (!!task.feature_key && decision.blocks.includes(String(task.feature_key))) ||
        decision.context.startsWith(`task-change/${key}/`) ||
        decision.context.startsWith(`task-spec/${key}/`)),
  );
  return {
    item,
    description:
      approvedTaskDescription(decisions, {
        key,
        declaration: task.declaration === null ? null : String(task.declaration),
      }) ??
      taskDeclarationText(task.declaration === null ? null : String(task.declaration))
        .description ??
      null,
    featureTitle: typeof feature?.title === 'string' ? feature.title : null,
    origin: items.find((candidate) => candidate.id === declaration.followUpOf) ?? null,
    impact: taskChangeImpact(item, items),
    decisions: relevant.map(projectTaskDecision),
    revision: createHash('sha256')
      .update(
        JSON.stringify({
          items,
          declarations: tasks.map(({ key, version, declaration }) => ({
            key,
            version,
            declaration,
          })),
          dependencies,
          rows,
          feature,
        }),
      )
      .digest('hex'),
    canChange: !!taskChangePolicy(String(task.status)),
  };
}
