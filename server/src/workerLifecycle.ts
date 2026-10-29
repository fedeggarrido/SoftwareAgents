import { randomUUID } from 'crypto';

import { recordAudit } from './auditLog.js';
import type { QuotaDecision } from './quotaGate.js';
import { LEASE_SWEEP_INTERVAL_MS } from './workstore/leasePolicy.js';
import type { TaskStatus } from './workstore/taskStateMachine.js';
import type { WorkStore } from './workstore/WorkStore.js';

/** One explicit task run, with SA-026 recovery as the only authority after a crash. */
export class WorkerLifecycle {
  readonly owner = `worker-${randomUUID()}`;
  private timer?: ReturnType<typeof setInterval>;
  private pending: Promise<void> = Promise.resolve();
  private failure?: Error;
  private claimed = false;
  private active = false;
  private cancel?: () => void;

  constructor(
    readonly store: WorkStore,
    readonly task: string,
  ) {}

  audit(status: string, reason?: string): void {
    recordAudit(
      'launch_execution',
      'task',
      this.task,
      { status, ...(reason ? { reason } : {}) },
      {
        projectId: this.store.projectId,
        actorType: 'system',
        actorId: this.owner,
        taskKey: this.task,
      },
    );
  }

  async claim(
    revision?: { gitSha: string; decisionId: string },
    reviewing: false | 'review' | 'qa' = false,
    publication = false,
  ): Promise<void> {
    if (this.claimed) return;
    let task = this.store.getTask(this.task);
    if (!task) {
      this.store.createTask({ key: this.task, type: 'unknown', status: 'DRAFT' });
      task = this.store.getTask(this.task)!;
    }
    if (!revision && !reviewing && ['DRAFT', 'WAITING_QUOTA'].includes(task.status))
      task = await this.store.transition(
        task.key,
        task.version,
        'READY',
        'Explicit worker run',
        this.owner,
      );
    if (publication) await this.store.claimWorkerPublication(task.key, this.owner);
    else if (reviewing) await this.store.claimReview(task.key, task.version, this.owner, reviewing);
    else if (revision)
      await this.store.claimRequirementsRevision(
        task.key,
        revision.gitSha,
        revision.decisionId,
        this.owner,
      );
    else if (['REVIEW', 'QA'].includes(task.status))
      await this.store.claimRework(task.key, task.version, this.owner);
    else await this.store.claim(task.key, this.owner);
    this.claimed = this.active = true;
    this.audit('lease_acquired');
    this.timer = setInterval(() => {
      this.pending = this.pending.then(async () => {
        if (!this.active || this.failure) return;
        try {
          await this.store.heartbeat(this.task, this.owner);
        } catch (error) {
          this.failure = error instanceof Error ? error : new Error(String(error));
          this.audit('lease_lost', this.failure.message);
          this.cancel?.();
        }
      });
    }, LEASE_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  assertOwned(): void {
    if (this.failure) throw this.failure;
    const task = this.store.getTask(this.task);
    if (
      !this.active ||
      task?.lease_owner !== this.owner ||
      !task.lease_expires_at ||
      task.lease_expires_at <= new Date().toISOString()
    )
      throw new Error('Worker lease lost');
  }

  async running(cancel: () => void): Promise<void> {
    this.cancel = cancel;
    this.assertOwned();
    const task = this.store.getTask(this.task)!;
    if (task.status === 'LEASED')
      await this.store.transition(
        this.task,
        task.version,
        'RUNNING',
        'Executor launch',
        this.owner,
      );
    this.audit('running');
  }

  async finish(status: TaskStatus, reason: string): Promise<void> {
    if (!this.active) return;
    await this.stopHeartbeat();
    this.assertOwned();
    const task = this.store.getTask(this.task)!;
    if (
      this.store
        .listDecisions()
        .some(
          (d) =>
            d.status !== 'answered' &&
            d.blocks.includes(this.task) &&
            (d.context.startsWith(`feature-requirements/${this.task}/`) ||
              d.context.startsWith(`feature-design/${this.task}/`)),
        )
    )
      status = 'WAITING_HUMAN';
    if (status === 'QA' && task.status !== 'REVIEW') {
      const review = await this.store.transition(
        this.task,
        task.version,
        'REVIEW',
        reason,
        this.owner,
      );
      await this.store.transition(this.task, review.version, 'QA', reason, this.owner);
    } else await this.store.transition(this.task, task.version, status, reason, this.owner);
    this.active = false;
    this.audit('task_transitioned', `${status}: ${reason}`);
    // WorkStore transitions out of active states clear the lease atomically.
    this.audit('lease_released');
  }

  async wait(gate: Extract<QuotaDecision, { status: 'wait' }>): Promise<void> {
    await this.finish(
      'WAITING_QUOTA',
      JSON.stringify({ reason: gate.reason, resetsAt: gate.resetsAt, cause: gate.cause }),
    );
  }

  async idleForDecision(reason: string): Promise<void> {
    await this.finish('FAILED_RETRYABLE', reason);
    const task = this.store.getTask(this.task)!;
    if (task.status === 'FAILED_RETRYABLE')
      await this.store.transition(this.task, task.version, 'READY', reason, this.owner);
  }

  /** Persist quota exhaustion before a fresh admission/claim for a fallback. */
  async releaseForQuotaRetry(gate: Extract<QuotaDecision, { status: 'wait' }>): Promise<void> {
    await this.wait(gate);
    this.claimed = false;
  }

  async stopHeartbeat(): Promise<void> {
    clearInterval(this.timer);
    await this.pending;
  }

  async completeReview(operation: () => Promise<void>): Promise<void> {
    await this.stopHeartbeat();
    this.assertOwned();
    await operation();
    this.active = false;
    this.audit('lease_released', 'ReviewReport and task outcome persisted');
  }

  async retainForRecovery(): Promise<void> {
    await this.stopHeartbeat();
    this.active = false;
    this.audit('lease_retained', 'Executor termination unconfirmed; SA-026 recovery required');
  }
}
