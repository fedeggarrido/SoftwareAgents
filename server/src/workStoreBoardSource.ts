import { Worker } from 'node:worker_threads';

import { PR_DISPLAY_REF_CHARS } from '../../core/src/constants.js';
import type { HumanDecision } from '../../core/src/humanDecision.js';
import type { BoardDecision, BoardEvent, BoardItem } from '../../core/src/messages.js';
import { projectPullRequest, projectPullRequestObservation } from '../../core/src/pullRequest.js';
import { BOARD_RECENT_EVENTS } from './constants.js';

interface TaskRow {
  key: string;
  type: string;
  status: string;
  priority: number;
  feature_key: string | null;
  agent_role: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  updated_at: string;
  execution_role: string | null;
  execution_key: string | null;
  session_id: string | null;
  pr_ref: string | null;
  pr_status: string | null;
  pr_observation: string | null;
}
interface EventRow {
  id: number;
  type: string;
  task_key: string;
  from_status: string;
  to_status: string;
  created_at: string;
}
interface Snapshot {
  tasks: TaskRow[];
  events: EventRow[];
  dependencies: { task_key: string; depends_on_key: string }[];
  decisions: { escalation: string }[];
}
export interface WorkStoreBoard {
  items: BoardItem[];
  recent: BoardEvent[];
  readable: boolean;
  decisions: BoardDecision[];
}

/** Self-contained worker entry point, also valid in the bundled standalone CLI.
 * SQLite's synchronous API and lock waits never run on the office event loop.
 * Only explicitly selected display fields cross the worker boundary.
 */
function readInWorker(): void {
  const { parentPort, workerData } = require('node:worker_threads');
  const { DatabaseSync } = require('node:sqlite');
  let db;
  try {
    db = new DatabaseSync(workerData.file, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 0; BEGIN');
    const project = workerData.projectId;
    if (!db.prepare('SELECT 1 FROM projects WHERE project_id = ?').get(project)) {
      parentPort.postMessage(null);
      return;
    }
    const hasPrStatus = db
      .prepare('PRAGMA table_info(tasks)')
      .all()
      .some((column: { name: string }) => column.name === 'pr_status');
    const hasPrObservation = (
      db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
    ).some((column) => column.name === 'pr_observation');
    const tasks = db
      .prepare(
        `
      SELECT t.key, t.type, t.status, t.priority, t.feature_key, t.agent_role,
             t.lease_owner, t.lease_expires_at, t.updated_at, t.pr_ref,
             ${hasPrStatus ? 't.pr_status' : 'NULL AS pr_status'}, ${hasPrObservation ? 't.pr_observation' : 'NULL AS pr_observation'},
             e.agent_role AS execution_role, e.key AS execution_key, e.session_id
      FROM tasks t LEFT JOIN executions e ON e.project_id = t.project_id AND e.key = (
        SELECT key FROM executions WHERE project_id = t.project_id AND task_key = t.key
        AND (t.lease_owner IS NULL OR task_version >= COALESCE((
          SELECT task_version FROM domain_events WHERE project_id = t.project_id AND task_key = t.key
          AND type = 'TASK_TRANSITIONED' AND (to_status = 'LEASED' OR (to_status = 'RUNNING' AND from_status IN ('REVIEW', 'QA')))
          ORDER BY id DESC LIMIT 1
        ), t.version))
        ORDER BY started_at DESC, key DESC LIMIT 1
      ) WHERE t.project_id = ? ORDER BY t.key`,
      )
      .all(project);
    const events = db
      .prepare(
        `
      SELECT id, type, task_key, from_status, to_status, created_at FROM domain_events
      WHERE project_id = ? AND (id IN (
        SELECT MAX(id) FROM domain_events WHERE project_id = ? GROUP BY task_key
      ) OR id IN (
        -- Limit after excluding FEAT-n / -DESIGN / -REQUIREMENTS documents (same rule as
        -- projectBoard), so document churn never pushes work events out of the history.
        SELECT id FROM domain_events WHERE project_id = ?
        AND NOT (task_key GLOB 'FEAT-[0-9]*' AND (
          task_key NOT GLOB 'FEAT-*-*' OR task_key GLOB 'FEAT-*-DESIGN' OR task_key GLOB 'FEAT-*-REQUIREMENTS'
        ))
        ORDER BY id DESC LIMIT ?
      )) ORDER BY id DESC`,
      )
      .all(project, project, project, workerData.recentEvents);
    const dependencies = db
      .prepare(
        'SELECT task_key, depends_on_key FROM task_dependencies WHERE project_id = ? ORDER BY depends_on_key',
      )
      .all(project);
    const decisions = db
      .prepare(
        'SELECT escalation FROM human_decisions WHERE project_id = ? AND escalation IS NOT NULL ORDER BY key',
      )
      .all(project);
    parentPort.postMessage({ tasks, events, dependencies, decisions });
  } catch {
    parentPort.postMessage({ error: true });
  } finally {
    db?.close();
  }
}

/** A fresh read transaction on every poll recovers both missed events and imports.
 * null means this WorkStore does not register the selected Project (legacy).
 * An unreadable existing store fails closed instead of showing obsolete claims.
 */
export class WorkStoreBoardSource {
  private worker: Worker | undefined;
  private pending: Promise<WorkStoreBoard | null> | undefined;

  read(file: string, projectId: string, now: number): Promise<WorkStoreBoard | null> {
    if (this.pending) return this.pending;
    this.pending = new Promise<WorkStoreBoard | null>((resolve) => {
      const worker = new Worker(`(${readInWorker.toString()})()`, {
        eval: true,
        // One worker per poll: without this, node:sqlite's ExperimentalWarning floods the log.
        execArgv: [...process.execArgv, '--disable-warning=ExperimentalWarning'],
        workerData: { file, projectId, recentEvents: BOARD_RECENT_EVENTS },
      });
      this.worker = worker;
      let result: WorkStoreBoard | null = { items: [], recent: [], decisions: [], readable: false };
      const failed = () => resolve({ items: [], recent: [], decisions: [], readable: false });
      worker.once('error', failed);
      worker.once('exit', () => resolve(result));
      worker.once('message', (data: Snapshot | { error: true } | null) => {
        try {
          if (data === null) result = null;
          else if ('error' in data) failed();
          else result = projectBoard(data, now);
        } catch {
          failed();
        }
      });
    })
      .catch(() => ({ items: [], recent: [], decisions: [], readable: false }))
      .finally(() => {
        this.pending = undefined;
        this.worker = undefined;
      });
    return this.pending;
  }

  dispose(): void {
    void this.worker?.terminate();
  }
}

function projectBoard(snapshot: Snapshot, now: number): WorkStoreBoard {
  const tasks = snapshot.tasks.filter((t) => !/^FEAT-\d+(?:-DESIGN|-REQUIREMENTS)?$/.test(t.key));
  const keys = new Set(tasks.map((t) => t.key));
  const events: BoardEvent[] = snapshot.events
    .filter((e) => keys.has(e.task_key))
    .map((e) => ({
      at: Date.parse(e.created_at),
      task: e.task_key,
      // The panel's "who" column: name the Task, not the raw event kind (seen in the office).
      session: e.task_key,
      phase: e.to_status,
      state: '',
      // Reasons/actors may contain prompts, paths or secrets: never transmit them.
      detail:
        e.type === 'PR_MERGED'
          ? 'PR merged'
          : e.type === 'PR_UPDATED'
            ? 'PR updated'
            : `${e.from_status} → ${e.to_status}`,
    }));
  const lastByTask = new Map<string, BoardEvent>();
  for (const event of events) if (!lastByTask.has(event.task)) lastByTask.set(event.task, event);
  const dependencies = new Map<string, string[]>();
  for (const edge of snapshot.dependencies) {
    const list = dependencies.get(edge.task_key) ?? [];
    list.push(edge.depends_on_key);
    dependencies.set(edge.task_key, list);
  }
  return {
    readable: true,
    decisions: snapshot.decisions
      .map((row) => JSON.parse(row.escalation) as HumanDecision)
      // Same allow-list as the domain relay's workSnapshot: pending gates only, never the
      // answer, who answered, or other free-form escalation fields (the office can be
      // viewed without the privileged token).
      .filter((d) => d.status === 'open' || d.status === 'expired')
      .map((d) => ({
        id: d.id,
        status: d.status,
        question: d.context,
        options: d.options.map((o) => o.id),
        structuredOptions: d.options.map(({ id, label, benefit, cost, risk }) => ({
          id,
          label,
          benefit,
          cost,
          risk,
        })),
        recommendation: d.recommendation,
        urgency: d.urgency,
        impact: d.impact,
        requestedBy: d.requestedBy,
        blocks: [...d.blocks],
      })),
    recent: events.slice(0, BOARD_RECENT_EVENTS),
    items: tasks.map((t) => {
      const role = t.execution_role ?? t.agent_role;
      const holder = t.lease_owner ?? role ?? t.execution_key;
      const active = t.status === 'LEASED' || t.status === 'RUNNING';
      return {
        id: t.key,
        // Task declarations are private; the canonical Task key is its safe title.
        title: t.key,
        epic: t.feature_key ?? undefined,
        phase: t.status,
        prRef: t.pr_ref?.slice(0, PR_DISPLAY_REF_CHARS),
        prStatus: projectPullRequest(t.pr_status),
        prObservation: projectPullRequestObservation(t.pr_observation),
        priority: String(t.priority),
        dependsOn: dependencies.get(t.key) ?? [],
        owner: holder
          ? {
              worker: holder,
              session: t.session_id ?? t.execution_key ?? '',
              state: active ? 'active' : t.status,
              stale: !!t.lease_owner && Date.parse(t.lease_expires_at ?? '') <= now,
              // WorkStore has no heartbeat; use the recorded Task update timestamp.
              heartbeatAt: Date.parse(t.updated_at),
            }
          : undefined,
        lastEvent: lastByTask.get(t.key),
        agentIds: [],
      };
    }),
  };
}
