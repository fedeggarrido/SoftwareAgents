import { DatabaseSync } from 'node:sqlite';

import type { SubmitTaskChange, TaskDetailError } from '../../core/src/messages.js';
import { TASK_CHANGE_MAX_CHARS } from '../../core/src/taskChangePolicy.js';
import { AuditLog } from './auditLog.js';
import { companyWorkspaceRoot } from './companyControl.js';
import { WORKSTORE_BUSY_TIMEOUT_MS } from './constants.js';
import { featureIngressActor } from './featureIngress.js';
import { loadProjectConfig } from './projectConfig.js';
import { projectTaskDetail } from './taskDetailProjection.js';
import { openReadOnlyWorkStore, workStoreFile } from './workstore/readOnlyWorkStore.js';
import { retryBusy } from './workstore/retryBusy.js';
import { TaskChangeFailure, writeTaskChange } from './workstore/taskChangeWrites.js';

/** Connection privilege and managed-process guard precede all project and database access. */
export async function handleTaskDetailMessage(
  msg: Record<string, unknown>,
  send: (message: Record<string, unknown>) => void,
  privileged: boolean,
  supported = true,
): Promise<void> {
  if (msg.type !== 'requestTaskDetail' && msg.type !== 'submitTaskChange') return;
  if (
    typeof msg.projectId !== 'string' ||
    typeof msg.requestId !== 'string' ||
    typeof msg.key !== 'string'
  )
    return;
  const submitting = msg.type === 'submitTaskChange';
  const base = { projectId: msg.projectId, requestId: msg.requestId, key: msg.key };
  const reply = (errorCode: TaskDetailError | null, followUpKey: string | null = null) =>
    send(
      submitting
        ? { ...base, type: 'taskChangeResult', followUpKey, errorCode }
        : { ...base, type: 'taskDetailSnapshot', detail: null, errorCode },
    );
  if (!privileged) return reply('denied');
  if (!supported) return reply('unsupported_adapter');
  if (submitting && featureIngressActor() !== 'human') return reply('managed_process');
  const fields = [
    'type',
    'projectId',
    'requestId',
    'key',
    ...(submitting ? ['revision', 'text'] : []),
  ];
  if (
    Object.keys(msg).some((field) => !fields.includes(field)) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(msg.key) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(msg.requestId) ||
    (submitting &&
      (typeof msg.revision !== 'string' ||
        !/^[a-f0-9]{64}$/.test(msg.revision) ||
        typeof msg.text !== 'string' ||
        !msg.text.trim() ||
        msg.text.length > TASK_CHANGE_MAX_CHARS))
  )
    return reply('invalid_request');
  let db: DatabaseSync | undefined;
  try {
    const root = companyWorkspaceRoot();
    const config = root && loadProjectConfig(root, submitting);
    if (!config || config.project.id !== msg.projectId) return reply('unknown_project');
    db = openReadOnlyWorkStore(config.repoRoot);
    db.exec('BEGIN');
    const detail = projectTaskDetail(db, msg.projectId, msg.key);
    if (!submitting) {
      send({
        ...base,
        type: 'taskDetailSnapshot',
        detail: {
          ...detail,
          canChange: detail.canChange && featureIngressActor() === 'human',
        },
        errorCode: null,
      });
      return;
    }
    db.close();
    db = new DatabaseSync(workStoreFile(config.repoRoot));
    db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${WORKSTORE_BUSY_TIMEOUT_MS}`);
    const request: SubmitTaskChange = {
      type: 'submitTaskChange',
      ...base,
      revision: String(msg.revision),
      text: String(msg.text),
    };
    const audit = new AuditLog();
    const append = (status: string) =>
      audit.append({
        action: 'task_change',
        resourceType: 'task',
        resourceId: request.key,
        projectId: request.projectId,
        actorType: 'human',
        actorId: 'operator',
        policyDecision: null,
        riskLevel: 'medium',
        taskKey: request.key,
        executionId: null,
        input: { requestId: request.requestId, revision: request.revision },
        outcome: { status },
      });
    const writer = db;
    const followUpKey = await retryBusy(
      writer,
      performance.now() + WORKSTORE_BUSY_TIMEOUT_MS,
      () => {
        writer.exec('BEGIN IMMEDIATE');
        try {
          const result = writeTaskChange(writer, request);
          append('pending');
          writer.exec('COMMIT');
          return result;
        } catch (error) {
          writer.exec('ROLLBACK');
          throw error;
        }
      },
    );
    try {
      append('recorded');
    } catch {
      console.error('[Pixel Agents] Task change audit confirmation pending');
    }
    reply(null, followUpKey);
  } catch (error) {
    reply(error instanceof TaskChangeFailure ? error.code : 'unavailable');
  } finally {
    db?.close();
  }
}
