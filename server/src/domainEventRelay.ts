import * as fs from 'fs';

import type { DomainEvent } from '../../core/src/domainEvents.js';
import type { HumanDecision } from '../../core/src/humanDecision.js';
import type {
  DomainEventMessage,
  WorkDecision,
  WorkSnapshot,
  WorkTask,
  WorkTaskStatus,
} from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { type BoardSelection, BoardSources } from './boardSources.js';
import { gitCommonDir } from './boardWatcher.js';
import {
  DOMAIN_EVENT_BATCH_LIMIT,
  DOMAIN_EVENT_MAX_BATCHES_PER_POLL,
  DOMAIN_EVENT_POLL_MS,
  WORKSTORE_RECONCILE_REASON_PREFIX,
} from './constants.js';
import { openReadOnly, type ReadOnlyDb } from './sqliteReadOnly.js';

/**
 * Work domain events to the office (SA-029): a snapshot on connect plus live notices.
 *
 * Reads the Project's WorkStore READ-ONLY (never opens it through openWorkStore,
 * whose lease sweeper writes) and relays `domain_events` rows with an id above
 * the last one seen, held in memory only. Nothing is acknowledged or persisted:
 * a notice lost to a restart or a disconnect is recovered by the next
 * workSnapshot, which carries the state itself. Broadcasts go through the
 * AgentStateStore; this module never touches a transport.
 */

const WORKSTORE_FILE = 'softwareagents/work.sqlite3';

export interface DomainEventRow {
  id: number;
  task_key: string;
  from_status: WorkTaskStatus;
  to_status: WorkTaskStatus;
  task_version: number;
  attempt: number;
  reason: string;
  created_at: string;
  agent_role: string | null;
}

/** Context a row alone does not carry, resolved by the relay against the same DB. */
export interface RowContext {
  executionId: string | null;
  decisionId: string | null;
}

const ACTIVE: readonly WorkTaskStatus[] = ['LEASED', 'RUNNING'];

/**
 * The notices one transition implies. Always task.state_changed, then the
 * semantic kinds the state machine makes certain; nothing inferred beyond it.
 * human.decision.answered requires the log to name the decision: leaving
 * WAITING_HUMAN otherwise (a cancellation) answers nothing.
 */
export function eventsFromTransition(
  projectId: string,
  row: DomainEventRow,
  context: RowContext,
): DomainEvent[] {
  const base = {
    eventId: row.id,
    projectId,
    taskKey: row.task_key,
    agentRole: row.agent_role,
    executionId: context.executionId,
    at: Date.parse(row.created_at),
    fromStatus: row.from_status,
    toStatus: row.to_status,
    taskVersion: row.task_version,
    attempt: row.attempt,
  };
  const events: DomainEvent[] = [{ ...base, kind: 'task.state_changed' }];
  const { from_status: from, to_status: to } = row;
  if (from === 'RUNNING') events.push({ ...base, kind: 'execution.finished' });
  if (to === 'LEASED') events.push({ ...base, kind: 'task.leased' });
  if (to === 'RUNNING') events.push({ ...base, kind: 'execution.started' });
  if (to === 'REVIEW') events.push({ ...base, kind: 'review.requested' });
  if (to === 'QA') events.push({ ...base, kind: 'qa.requested' });
  if (to === 'WAITING_QUOTA') events.push({ ...base, kind: 'quota.waiting' });
  if (to === 'WAITING_HUMAN')
    events.push({ ...base, kind: 'human.decision.required', decisionId: context.decisionId });
  if (from === 'WAITING_HUMAN' && context.decisionId !== null)
    events.push({ ...base, kind: 'human.decision.answered', decisionId: context.decisionId });
  return events;
}

/** Decision a WAITING_HUMAN transition names: its reason is the decision id (or the reconcile form). */
function decisionIdFor(db: ReadOnlyDb, projectId: string, row: DomainEventRow): string | null {
  if (row.from_status !== 'WAITING_HUMAN' && row.to_status !== 'WAITING_HUMAN') return null;
  const query = db.prepare('SELECT * FROM human_decisions WHERE project_id = ? AND key = ?');
  type DecisionRow = {
    key: string;
    task_key: string | null;
    answer: string;
    escalation?: string | null;
  };
  // A decision id may itself start with the reconcile prefix.
  const found = (query.get(projectId, row.reason) ??
    (row.reason.startsWith(WORKSTORE_RECONCILE_REASON_PREFIX)
      ? query.get(projectId, row.reason.slice(WORKSTORE_RECONCILE_REASON_PREFIX.length))
      : undefined)) as DecisionRow | undefined;
  if (!found) return null;
  if (found.escalation) {
    let decision: HumanDecision;
    try {
      decision = JSON.parse(found.escalation) as HumanDecision;
    } catch {
      // A malformed row loses its attribution; it must not wedge the cursor on retries.
      return null;
    }
    if (!Array.isArray(decision?.blocks) || !decision.blocks.includes(row.task_key)) return null;
    // A delayed poll may read the required transition after the answer was committed.
    if (row.to_status === 'WAITING_HUMAN')
      return ['open', 'expired', 'answered'].includes(decision.status) ? found.key : null;
    return decision.status === 'answered' ? found.key : null;
  }
  return found.task_key === row.task_key &&
    (row.to_status === 'WAITING_HUMAN' || found.answer.trim() !== '')
    ? found.key
    : null;
}

/**
 * The Execution of the active window (LEASED/RUNNING) a transition belongs to:
 * created at or after the window's start (its lease, or a REVIEW/QA rework)
 * and no later than this transition. Outside such a window, or before the
 * worker records it, the answer is null rather than an older attempt's.
 */
function executionIdFor(db: ReadOnlyDb, projectId: string, row: DomainEventRow): string | null {
  if (!ACTIVE.includes(row.from_status) && !ACTIVE.includes(row.to_status)) return null;
  const start = db
    .prepare(
      `SELECT MAX(task_version) AS version FROM domain_events
       WHERE project_id = ? AND task_key = ? AND task_version <= ?
         AND (to_status = 'LEASED' OR (to_status = 'RUNNING' AND from_status IN ('REVIEW', 'QA')))`,
    )
    .get(projectId, row.task_key, row.task_version) as { version: number | null } | undefined;
  if (typeof start?.version !== 'number') return null;
  const execution = db
    .prepare(
      `SELECT key FROM executions
       WHERE project_id = ? AND task_key = ? AND task_version BETWEEN ? AND ?
       ORDER BY task_version DESC, started_at DESC, key DESC LIMIT 1`,
    )
    .get(
      projectId,
      row.task_key,
      start.version,
      ACTIVE.includes(row.to_status) ? row.task_version : row.task_version - 1,
    ) as { key: string } | undefined;
  return execution?.key ?? null;
}

function tableExists(db: ReadOnlyDb, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/** Read one consistent view of the Project's open work. Throws when the DB cannot be read. */
function readSnapshot(
  db: ReadOnlyDb,
  projectId: string,
): Pick<WorkSnapshot, 'tasks' | 'decisions' | 'lastEventId'> {
  db.exec('BEGIN'); // one WAL read snapshot across every query
  try {
    if (!tableExists(db, 'tasks')) return { tasks: [], decisions: [], lastEventId: null };
    const dependsOn = new Map<string, string[]>();
    for (const dep of db
      .prepare(
        'SELECT task_key, depends_on_key FROM task_dependencies WHERE project_id = ? ORDER BY task_key, depends_on_key',
      )
      .all(projectId) as { task_key: string; depends_on_key: string }[]) {
      const list = dependsOn.get(dep.task_key) ?? [];
      list.push(dep.depends_on_key);
      dependsOn.set(dep.task_key, list);
    }
    const tasks = (
      db
        .prepare(
          `SELECT key, type, status, priority, agent_role, feature_key, version, attempt, updated_at
           FROM tasks WHERE project_id = ? ORDER BY key`,
        )
        .all(projectId) as {
        key: string;
        type: string;
        status: WorkTaskStatus;
        priority: number;
        agent_role: string | null;
        feature_key: string | null;
        version: number;
        attempt: number;
        updated_at: string;
      }[]
    ).map((t): WorkTask => ({
      key: t.key,
      type: t.type,
      status: t.status,
      priority: t.priority,
      agentRole: t.agent_role,
      featureKey: t.feature_key,
      version: t.version,
      attempt: t.attempt,
      dependsOn: dependsOn.get(t.key) ?? [],
      updatedAt: Date.parse(t.updated_at),
    }));
    // Older schemas have no escalation column: no structured decisions yet.
    const hasEscalation = (
      db.prepare('PRAGMA table_info(human_decisions)').all() as { name: string }[]
    ).some((c) => c.name === 'escalation');
    const decisions = hasEscalation
      ? (
          db
            .prepare(
              'SELECT escalation FROM human_decisions WHERE project_id = ? AND escalation IS NOT NULL ORDER BY key',
            )
            .all(projectId) as { escalation: string }[]
        )
          // A corrupt row throws: the snapshot reports unreadable rather than hiding a gate.
          .map((row) => JSON.parse(row.escalation) as HumanDecision)
          .filter((d) => d.status === 'open' || d.status === 'expired')
          .map((d): WorkDecision => ({
            id: d.id,
            status: d.status as WorkDecision['status'],
            context: d.context,
            options: d.options.map(({ id, label, benefit, cost, risk }) => ({
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
          }))
      : [];
    const last = tableExists(db, 'domain_events')
      ? (db
          .prepare('SELECT MAX(id) AS id FROM domain_events WHERE project_id = ?')
          .get(projectId) as { id: number | null } | undefined)
      : undefined;
    return { tasks, decisions, lastEventId: last?.id ?? null };
  } finally {
    db.exec('COMMIT');
  }
}

export interface DomainEventRelayOptions {
  projectId: string;
  /** Resolved (path-guarded) WorkStore file, or undefined when it cannot be located. */
  workStoreFile: () => string | undefined;
  now?: () => number;
  pollMs?: number;
}

let active: DomainEventRelay | undefined;

/** A fresh snapshot for a client that just connected, when this server relays a Project. */
export function currentWorkSnapshot(): WorkSnapshot | undefined {
  return active?.snapshot();
}

export class DomainEventRelay {
  /** Last domain_events id relayed; undefined until the log has been read once. */
  private cursor: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;

  constructor(
    private readonly store: AgentStateStore,
    private readonly options: DomainEventRelayOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    active = this;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.options.pollMs ?? DOMAIN_EVENT_POLL_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (active === this) active = undefined;
  }

  snapshot(): WorkSnapshot {
    const base = { type: 'workSnapshot', projectId: this.options.projectId } as const;
    const file = this.options.workStoreFile();
    const db = file ? openReadOnly(file) : undefined;
    if (!db) {
      // No file is a real, empty state; one we cannot locate or open is unknown.
      return {
        ...base,
        source: file && !fs.existsSync(file) ? 'missing' : 'unreadable',
        lastEventId: null,
        tasks: [],
        decisions: [],
        generatedAt: this.now(),
      };
    }
    try {
      const snapshot = readSnapshot(db, this.options.projectId);
      // The first successful snapshot is the history boundary if polling has not
      // established one yet. Later snapshots must not skip undelivered notices.
      this.cursor ??= snapshot.lastEventId ?? 0;
      return {
        ...base,
        source: 'ok',
        ...snapshot,
        generatedAt: this.now(),
      };
    } catch (error) {
      console.error('[Pixel Agents] WorkStore snapshot unreadable:', error);
      return {
        ...base,
        source: 'unreadable',
        lastEventId: null,
        tasks: [],
        decisions: [],
        generatedAt: this.now(),
      };
    } finally {
      db.close();
    }
  }

  /** Relay rows newer than the cursor. Errors keep the cursor, so the next poll retries. */
  tick(): void {
    const file = this.options.workStoreFile();
    // Not locatable (Git or path guard failed): unknown, so the cursor stays put
    // rather than replaying an existing log as news once it resolves again.
    if (!file) return;
    if (!fs.existsSync(file)) {
      // Everything a WorkStore created from now on contains is new.
      this.cursor = 0;
      return;
    }
    const db = openReadOnly(file);
    if (!db) return;
    try {
      if (!tableExists(db, 'domain_events')) {
        this.cursor = 0;
        return;
      }
      const projectId = this.options.projectId;
      if (this.cursor === undefined) {
        // History before this server started is state, served by workSnapshot, not news.
        const last = db
          .prepare('SELECT MAX(id) AS id FROM domain_events WHERE project_id = ?')
          .get(projectId) as { id: number | null } | undefined;
        this.cursor = last?.id ?? 0;
        return;
      }
      for (let batch = 0; batch < DOMAIN_EVENT_MAX_BATCHES_PER_POLL; batch++) {
        const rows = db
          .prepare(
            `SELECT de.id, de.task_key, de.from_status, de.to_status, de.task_version, de.attempt,
                    de.reason, de.created_at, t.agent_role
             FROM domain_events de
             LEFT JOIN tasks t ON t.project_id = de.project_id AND t.key = de.task_key
             WHERE de.project_id = ? AND de.id > ? ORDER BY de.id LIMIT ?`,
          )
          .all(projectId, this.cursor, DOMAIN_EVENT_BATCH_LIMIT) as unknown as DomainEventRow[];
        for (const row of rows) {
          const events = eventsFromTransition(projectId, row, {
            executionId: executionIdFor(db, projectId, row),
            decisionId: decisionIdFor(db, projectId, row),
          });
          for (const event of events)
            this.store.broadcast({ type: 'domainEvent', event } satisfies DomainEventMessage);
          this.cursor = row.id;
        }
        if (rows.length < DOMAIN_EVENT_BATCH_LIMIT) break;
      }
    } catch (error) {
      console.error('[Pixel Agents] Domain event relay read failed; retrying:', error);
    } finally {
      db.close();
    }
  }
}

/** The relay for the server's own Project, or undefined outside a valid Project binding. */
export function createDomainEventRelay(
  store: AgentStateStore,
  workspaceDir: string,
  selection: BoardSelection,
): DomainEventRelay | undefined {
  if (selection.kind !== 'project') return undefined;
  const sources = new BoardSources(workspaceDir, selection);
  let commonDir: string | undefined;
  return new DomainEventRelay(store, {
    projectId: selection.project.project.id,
    workStoreFile: () => {
      commonDir ??= gitCommonDir(workspaceDir);
      return sources.source(commonDir, WORKSTORE_FILE);
    },
  });
}
