import type { ClickUpMirrorConfig, ClickUpMirrorState } from '../../../../core/src/project.js';
import type { PolicyActor, PolicyDecision } from '../../policy.js';
import type { TaskStatus } from '../../workstore/taskStateMachine.js';
import type { TaskRecord } from '../../workstore/WorkStore.js';
import type { ClickUpClient, ClickUpTask } from './client.js';

/** One work-store state per ClickUp column; CANCELLED has no column and is left alone. */
const MIRRORED: Record<TaskStatus, ClickUpMirrorState | null> = {
  DRAFT: 'READY',
  READY: 'READY',
  QUEUED: 'READY',
  LEASED: 'IN_PROGRESS',
  RUNNING: 'IN_PROGRESS',
  REVIEW: 'REVIEW',
  QA: 'QA',
  BLOCKED: 'BLOCKED',
  WAITING_HUMAN: 'BLOCKED',
  WAITING_QUOTA: 'BLOCKED',
  FAILED_RETRYABLE: 'BLOCKED',
  FAILED_FINAL: 'BLOCKED',
  DONE: 'DONE',
  CANCELLED: null,
};

export type MirrorOutcome =
  | { key: string; result: 'in_sync' | 'unmapped' | 'unmatched' }
  | { key: string; result: 'denied' | 'failed'; clickupId: string; reason: string }
  | {
      key: string;
      result: 'mirrored' | 'would_mirror';
      clickupId: string;
      /** Present when the status drifted: what ClickUp had and what the work store wants. */
      status: { from: string; to: string } | null;
      prComment: boolean;
    };

export interface MirrorRun {
  tasks: readonly TaskRecord[];
  listIds: readonly string[];
  config: ClickUpMirrorConfig;
  client: ClickUpClient;
  /** clickup_write for the caller's actor; asked once, applied only to tasks with pending writes. */
  authorize: (actor: PolicyActor) => PolicyDecision;
  actor: PolicyActor;
  /** Drift found, writes done, denials and failures; never in a dry run. */
  record: (event: MirrorAuditEvent) => void;
  dryRun?: boolean;
}

export interface MirrorAuditEvent {
  action: 'clickup_status' | 'clickup_comment';
  key: string;
  clickupId: string;
  status: 'drift' | 'written' | 'denied' | 'failed';
  detail: string;
  decision: PolicyDecision;
}

/** The comment linking a PR; its trimmed text is the idempotency key. */
export function pullRequestComment(key: string, pr: string): string {
  return `SoftwareAgents · ${key} · PR: ${pr}`;
}

/** ClickUp task bound to a work-store key: custom id first, then a name that starts with it
 *  followed by a separator (so SA-053 never binds SA-0530 or the sub-task SA-053.1). */
function bound(key: string, tasks: readonly ClickUpTask[]): ClickUpTask | undefined {
  return (
    tasks.find((task) => task.customId === key) ??
    tasks.find((task) => task.name.startsWith(key) && !/[\w.-]/.test(task.name.charAt(key.length)))
  );
}

/**
 * The work store wins: drift in ClickUp (a hand-made change included) is audited and
 * overwritten. Reads are free; writes need clickup_write. One task failing never stops the rest.
 */
export async function reconcileClickUp(run: MirrorRun): Promise<MirrorOutcome[]> {
  const remote = (await Promise.all(run.listIds.map((id) => run.client.listTasks(id)))).flat();
  const decision = run.authorize(run.actor);
  const outcomes: MirrorOutcome[] = [];
  for (const task of run.tasks) {
    const state = MIRRORED[task.status];
    const target = state ? bound(task.key, remote) : undefined;
    if (!state || !target) {
      outcomes.push({ key: task.key, result: state ? 'unmatched' : 'unmapped' });
      continue;
    }
    const record = (
      action: MirrorAuditEvent['action'],
      status: MirrorAuditEvent['status'],
      detail: string,
    ) => {
      if (!run.dryRun)
        run.record({ action, key: task.key, clickupId: target.id, status, detail, decision });
    };
    const wanted = run.config.statuses[state];
    const status =
      target.status.toLowerCase() === wanted.toLowerCase()
        ? null
        : { from: target.status, to: wanted };
    const action = status ? 'clickup_status' : 'clickup_comment';
    try {
      const comment = task.pr_ref ? pullRequestComment(task.key, task.pr_ref) : null;
      const prComment =
        comment !== null &&
        !(await run.client.comments(target.id)).some((text) => text.trim() === comment);
      if (!status && !prComment) {
        outcomes.push({ key: task.key, result: 'in_sync' });
        continue;
      }
      if (decision.outcome !== 'allow') {
        record(action, 'denied', decision.reason);
        outcomes.push({
          key: task.key,
          result: 'denied',
          clickupId: target.id,
          reason: decision.reason,
        });
        continue;
      }
      if (status) {
        record('clickup_status', 'drift', `${status.from} → ${status.to}`);
        if (!run.dryRun) await run.client.setStatus(target.id, status.to);
        record('clickup_status', 'written', status.to);
      }
      if (prComment && comment) {
        if (!run.dryRun) await run.client.comment(target.id, comment);
        record('clickup_comment', 'written', task.pr_ref ?? '');
      }
      outcomes.push({
        key: task.key,
        result: run.dryRun ? 'would_mirror' : 'mirrored',
        clickupId: target.id,
        status,
        prComment,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      record(action, 'failed', reason);
      outcomes.push({ key: task.key, result: 'failed', clickupId: target.id, reason });
    }
  }
  return outcomes;
}
