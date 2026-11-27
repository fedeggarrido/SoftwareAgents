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
  | {
      key: string;
      result: 'corrected' | 'would_correct';
      clickupId: string;
      from: string;
      to: string;
    }
  | { key: string; result: 'denied'; clickupId: string; reason: string }
  | { key: string; result: 'pr_commented' | 'would_comment'; clickupId: string };

export interface MirrorRun {
  tasks: readonly TaskRecord[];
  listIds: readonly string[];
  config: ClickUpMirrorConfig;
  client: ClickUpClient;
  /** Decides clickup_write once per run (evaluatePolicy with the caller's actor). */
  authorize: (actor: PolicyActor) => PolicyDecision;
  actor: PolicyActor;
  /** Every write and every drift found, before and after the write. */
  record: (event: MirrorAuditEvent) => void;
  dryRun?: boolean;
}

export interface MirrorAuditEvent {
  action: 'clickup_status' | 'clickup_comment';
  key: string;
  clickupId: string;
  status: 'drift' | 'written' | 'denied';
  detail: string;
}

/** The comment linking a PR; its exact text is the idempotency key. */
export function pullRequestComment(key: string, pr: string): string {
  return `SoftwareAgents · ${key} · PR: ${pr}`;
}

/** ClickUp task bound to a work-store key: custom id first, then a name that starts with it. */
function bound(key: string, tasks: readonly ClickUpTask[]): ClickUpTask | undefined {
  return (
    tasks.find((task) => task.customId === key) ??
    tasks.find((task) => task.name.startsWith(key) && !/[\w-]/.test(task.name.charAt(key.length)))
  );
}

/**
 * The work store wins: drift in ClickUp (a hand-made change included) is recorded as
 * drift and overwritten. Writes go through clickup_write; a denial writes nothing.
 */
export async function reconcileClickUp(run: MirrorRun): Promise<MirrorOutcome[]> {
  if (!run.config.enabled) return [];
  const remote = (await Promise.all(run.listIds.map((id) => run.client.listTasks(id)))).flat();
  const decision = run.authorize(run.actor);
  const outcomes: MirrorOutcome[] = [];
  for (const task of run.tasks) {
    const state = MIRRORED[task.status];
    if (!state) {
      outcomes.push({ key: task.key, result: 'unmapped' });
      continue;
    }
    const target = bound(task.key, remote);
    if (!target) {
      outcomes.push({ key: task.key, result: 'unmatched' });
      continue;
    }
    const wanted = run.config.statuses[state];
    const drift = target.status.toLowerCase() !== wanted.toLowerCase();
    const comment = task.pr_ref ? pullRequestComment(task.key, task.pr_ref) : null;
    if (!drift && !comment) {
      outcomes.push({ key: task.key, result: 'in_sync' });
      continue;
    }
    if (decision.outcome !== 'allow' && !run.dryRun) {
      run.record({
        action: 'clickup_status',
        key: task.key,
        clickupId: target.id,
        status: 'denied',
        detail: decision.reason,
      });
      outcomes.push({
        key: task.key,
        result: 'denied',
        clickupId: target.id,
        reason: decision.reason,
      });
      continue;
    }
    if (drift) {
      const event = { action: 'clickup_status', key: task.key, clickupId: target.id } as const;
      run.record({ ...event, status: 'drift', detail: `${target.status} → ${wanted}` });
      if (!run.dryRun) {
        await run.client.setStatus(target.id, wanted);
        run.record({ ...event, status: 'written', detail: wanted });
      }
      outcomes.push({
        key: task.key,
        result: run.dryRun ? 'would_correct' : 'corrected',
        clickupId: target.id,
        from: target.status,
        to: wanted,
      });
    }
    if (comment && !(await run.client.comments(target.id)).includes(comment)) {
      if (!run.dryRun) {
        await run.client.comment(target.id, comment);
        run.record({
          action: 'clickup_comment',
          key: task.key,
          clickupId: target.id,
          status: 'written',
          detail: task.pr_ref ?? '',
        });
      }
      outcomes.push({
        key: task.key,
        result: run.dryRun ? 'would_comment' : 'pr_commented',
        clickupId: target.id,
      });
    } else if (!drift) outcomes.push({ key: task.key, result: 'in_sync' });
  }
  return outcomes;
}
