import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { HumanDecision } from '../../../core/src/humanDecision.js';
import type { SubmitTaskChange, TaskChangeResult } from '../../../core/src/messages.js';
import { taskChangePolicy } from '../../../core/src/taskChangePolicy.js';
import { WORKSTORE_DEFAULT_MAX_ATTEMPTS } from '../constants.js';
import { taskSpecPrefix } from '../taskChangeDecisions.js';
import { projectTaskDetail } from '../taskDetailProjection.js';

export class TaskChangeFailure extends Error {
  constructor(readonly code: NonNullable<TaskChangeResult['errorCode']>) {
    super(code);
  }
}

/** Runs under BEGIN IMMEDIATE. The request, gate, task and idempotency result commit together. */
export function writeTaskChange(db: DatabaseSync, request: SubmitTaskChange): string | null {
  const { projectId, key, requestId, text } = request;
  const idempotencyKey = `task-change/${requestId}`;
  const previous = db
    .prepare('SELECT result FROM idempotency_keys WHERE project_id = ? AND key = ?')
    .get(projectId, idempotencyKey);
  if (previous) {
    const result: unknown = JSON.parse(String(previous.result));
    if (
      !result ||
      typeof result !== 'object' ||
      !('key' in result) ||
      result.key !== key ||
      !('revision' in result) ||
      result.revision !== request.revision ||
      !('text' in result) ||
      result.text !== text ||
      !('followUpKey' in result) ||
      !(result.followUpKey === null || typeof result.followUpKey === 'string')
    )
      throw new TaskChangeFailure('invalid_request');
    return result.followUpKey;
  }
  const detail = projectTaskDetail(db, projectId, key);
  if (detail.revision !== request.revision) throw new TaskChangeFailure('stale_revision');
  const kind = taskChangePolicy(detail.item.phase);
  if (!kind) throw new TaskChangeFailure('invalid_request');
  const task = db
    .prepare(
      'SELECT declaration, lease_owner, status, attempt, version, feature_key, priority FROM tasks WHERE project_id = ? AND key = ?',
    )
    .get(projectId, key)!;
  if (
    db
      .prepare('SELECT 1 FROM lease_recoveries WHERE project_id = ? AND task_key = ?')
      .get(projectId, key)
  )
    throw new TaskChangeFailure('unavailable');
  const now = new Date().toISOString();
  let followUpKey: string | null = null;
  if (kind === 'follow_up') {
    let index = 1;
    do {
      followUpKey = `FOLLOWUP-${String(index++).padStart(3, '0')}`;
    } while (
      db.prepare('SELECT 1 FROM tasks WHERE project_id = ? AND key = ?').get(projectId, followUpKey)
    );
    db.prepare(
      `INSERT INTO tasks (project_id, key, type, status, priority, version, attempt, max_attempts, created_at, updated_at, feature_key, declaration)
      VALUES (?, ?, 'unknown', 'DRAFT', ?, 1, 0, ?, ?, ?, ?, ?)`,
    ).run(
      projectId,
      followUpKey,
      task.priority,
      WORKSTORE_DEFAULT_MAX_ATTEMPTS,
      now,
      now,
      task.feature_key,
      JSON.stringify({
        title: `Seguimiento de ${detail.item.title}`,
        description: text,
        followUpOf: key,
      }),
    );
  } else {
    const spec = kind === 'revise_spec';
    const executionOpen = db
      .prepare(
        'SELECT 1 FROM executions WHERE project_id = ? AND task_key = ? AND pid IS NOT NULL AND tree_closed_at IS NULL',
      )
      .get(projectId, key);
    if (spec && (task.lease_owner !== null || executionOpen))
      throw new TaskChangeFailure('stale_revision');
    const suspend =
      spec ||
      (task.lease_owner === null &&
        !executionOpen &&
        task.status !== 'WAITING_HUMAN' &&
        !detail.decisions.some((decision) => decision.blocks?.includes(key)));
    const id = randomUUID();
    const context = `${spec ? taskSpecPrefix({ key, declaration: typeof task.declaration === 'string' ? task.declaration : null }) : `task-change/${key}/`}${id}\n${text}`;
    const decision: HumanDecision = {
      id,
      context,
      status: 'open',
      blocks: suspend ? [key] : [],
      requestedBy: 'operator',
      answeredBy: null,
      answeredAt: null,
      recommendation: 'Revisar el cambio y su impacto antes de continuar.',
      disagreement: [],
      urgency: 'medium',
      impact: spec
        ? 'La tarea espera la aprobación de la especificación editada.'
        : 'Solicitud para el próximo punto seguro. Se conserva el trabajo realizado.',
      options: [
        {
          id: spec ? 'approve' : 'review',
          label: spec ? 'Aprobar especificación' : 'Revisar el cambio en el punto seguro',
          benefit: 'Permite continuar tras la revisión humana.',
          cost: 'Revisión humana del impacto.',
          risk: 'Puede requerir ajustar el plan.',
        },
        {
          id: 'keep',
          label: 'Conservar la especificación actual',
          benefit: 'Permite continuar con el alcance aprobado.',
          cost: 'El cambio queda descartado.',
          risk: 'La necesidad puede seguir pendiente.',
        },
      ],
    };
    db.prepare(
      'INSERT INTO human_decisions(project_id,key,task_key,question,answer,actor,decided_at,escalation,previous_states) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(
      projectId,
      id,
      key,
      context,
      '',
      'operator',
      '',
      JSON.stringify(decision),
      JSON.stringify(suspend ? { [key]: task.status } : {}),
    );
    if (suspend) {
      db.prepare(
        "UPDATE tasks SET status = 'WAITING_HUMAN', version = version + 1, updated_at = ? WHERE project_id = ? AND key = ?",
      ).run(now, projectId, key);
      db.prepare(
        "INSERT INTO domain_events(project_id,task_key,type,from_status,to_status,task_version,attempt,reason,actor,created_at) VALUES (?,?,'TASK_TRANSITIONED',?,'WAITING_HUMAN',?,?,?,'human',?)",
      ).run(projectId, key, task.status, Number(task.version) + 1, task.attempt, id, now);
    }
  }
  db.prepare(
    "INSERT INTO idempotency_keys(project_id,key,state,result,created_at) VALUES (?,?,'COMPLETED',?,?)",
  ).run(
    projectId,
    idempotencyKey,
    JSON.stringify({ key, revision: request.revision, text, followUpKey }),
    now,
  );
  return followUpKey;
}
