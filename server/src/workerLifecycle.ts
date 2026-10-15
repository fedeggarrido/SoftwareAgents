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

  async claim(): Promise<void> {
    if (this.claimed) return;
    let task = this.store.getTask(this.task);
    if (!task) {
      this.store.createTask({ key: this.task, type: 'unknown', status: 'DRAFT' });
      task = this.store.getTask(this.task)!;
    }
    if (['DRAFT', 'WAITING_QUOTA'].includes(task.status))
      task = await this.store.transition(
        task.key,
        task.version,
        'READY',
        'Explicit worker run',
        this.owner,
      );
    if (['REVIEW', 'QA'].includes(task.status))
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
    await this.store.transition(this.task, task.version, status, reason, this.owner);
    this.active = false;
    this.audit('task_transitioned', `${status}: ${reason}`);
    // WorkStore transitions out of active states clear the lease atomically.
    this.audit('lease_released');
  }

  async wait(gate: Extract<QuotaDecision, { status: 'wait' }>): Promise<void> {
    await this.finish(
      'WAITING_QUOTA',
      JSON.stringify({ reason: gate.reason, resetsAt: gate.resetsAt }),
    );
  }

  async idleForDecision(reason: string): Promise<void> {
    await this.finish('FAILED_RETRYABLE', reason);
    const task = this.store.getTask(this.task)!;
    if (task.status === 'FAILED_RETRYABLE')
      await this.store.transition(this.task, task.version, 'READY', reason, this.owner);
  }

  async stopHeartbeat(): Promise<void> {
    clearInterval(this.timer);
    await this.pending;
  }

  async retainForRecovery(): Promise<void> {
    await this.stopHeartbeat();
    this.active = false;
    this.audit('lease_retained', 'Executor termination unconfirmed; SA-026 recovery required');
  }
}
