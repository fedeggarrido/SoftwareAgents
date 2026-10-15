import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { ModelTier } from '../../../core/src/modelTier.js';
import type { CascadeAttempt } from '../modelCascade.js';
import { resolveInside } from '../pathGuard.js';
import type { ExecutionHandle, ExecutionRequest, Executor, ExecutorId } from './executor.js';

export interface SessionExecution {
  executionId: string;
  role: string;
  taskKey: string;
  tier?: ModelTier;
  model?: string | null;
  effort?: string;
  selectionReason?: string;
}

export interface ExecutionRecord extends SessionExecution {
  projectId: string;
  executor: ExecutorId;
  model: string | null;
  sessionId: string;
  pid: number;
  startedAt: string;
  promptHash: string;
  baseSha: string;
}

function git(worktree: string, args: string[]): string {
  return execFileSync('git', args, { cwd: worktree, encoding: 'utf8', windowsHide: true }).trim();
}

/** Local transitional ledger. A held/crashed lock fails closed; never steal it. */
export class ExecutionRegistry {
  private readonly root: string;

  constructor(worktreePath: string) {
    this.root = path.resolve(worktreePath, git(worktreePath, ['rev-parse', '--git-common-dir']));
  }

  cascadeAttempt(executionId: string, taskKey: string, outcome: CascadeAttempt): void {
    this.append('softwareagents/cascade-attempts.jsonl', { executionId, taskKey, ...outcome });
  }

  private append(relative: string, value: unknown): void {
    const destination = resolveInside(this.root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const lock = resolveInside(this.root, `${relative}.lock`);
    const lockFd = fs.openSync(lock, 'wx', 0o600);
    try {
      const fd = fs.openSync(resolveInside(this.root, relative), 'a', 0o600);
      try {
        const data = Buffer.from(`${JSON.stringify(value)}\n`);
        let offset = 0;
        while (offset < data.length) {
          offset += fs.writeSync(fd, data, offset, data.length - offset);
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      fs.closeSync(lockFd);
      fs.unlinkSync(lock);
    }
  }

  sessionMap(): ReadonlyMap<string, SessionExecution> {
    const file = resolveInside(this.root, 'softwareagents/executions.jsonl');
    if (!fs.existsSync(file)) {
      return new Map();
    }
    const result = new Map<string, SessionExecution>();
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const record = JSON.parse(line) as ExecutionRecord;
      result.set(record.sessionId, {
        executionId: record.executionId,
        role: record.role,
        taskKey: record.taskKey,
        ...(record.tier
          ? {
              tier: record.tier,
              model: record.model,
              effort: record.effort,
              selectionReason: record.selectionReason,
            }
          : {}),
      });
    }
    return result;
  }

  /** Snapshot HEAD before start. Events are recorded as the caller drains the handle. */
  executor(inner: Executor, options: { metricsOnly?: boolean } = {}): Executor {
    const registry = this;
    return {
      id: inner.id,
      start(input: ExecutionRequest): ExecutionHandle {
        const req = { ...input, flags: [...input.flags] };
        if (!/^[a-zA-Z0-9_-]+$/.test(req.executionId)) {
          throw new Error('Invalid executionId');
        }
        const baseSha = git(req.worktreePath, ['rev-parse', 'HEAD']);
        const run = `softwareagents/runs/${req.executionId}.jsonl`;
        // Claim the run before launching; duplicate Execution IDs must not mix logs.
        const runPath = resolveInside(registry.root, run);
        fs.mkdirSync(path.dirname(runPath), { recursive: true });
        fs.closeSync(fs.openSync(resolveInside(registry.root, run), 'wx', 0o600));
        const handle = inner.start(req);
        if (handle.sessionId) {
          registry.append('softwareagents/executions.jsonl', {
            executionId: req.executionId,
            projectId: req.projectId,
            role: req.role,
            taskKey: req.taskKey,
            executor: inner.id,
            model: req.model ?? null,
            tier: req.tier,
            effort: req.effort,
            selectionReason: req.selectionReason,
            sessionId: handle.sessionId,
            pid: 0,
            startedAt: new Date().toISOString(),
            promptHash: createHash('sha256').update(req.prompt).digest('hex'),
            baseSha,
          });
        }
        return {
          sessionId: handle.sessionId,
          cancel: () => handle.cancel(),
          events: (async function* () {
            try {
              for await (const event of handle.events) {
                if (event.type === 'started') {
                  const record: ExecutionRecord = {
                    executionId: req.executionId,
                    projectId: req.projectId,
                    role: req.role,
                    taskKey: req.taskKey,
                    executor: inner.id,
                    model: req.model ?? null,
                    tier: req.tier,
                    effort: req.effort,
                    selectionReason: req.selectionReason,
                    sessionId: event.sessionId,
                    pid: event.pid,
                    startedAt: event.startedAt,
                    promptHash: createHash('sha256').update(req.prompt).digest('hex'),
                    baseSha,
                  };
                  registry.append('softwareagents/executions.jsonl', record);
                }
                if (!options.metricsOnly || event.type === 'telemetry') registry.append(run, event);
                else if (event.type === 'finished')
                  registry.append(run, { type: 'finished', exitCode: event.exitCode });
                yield event;
              }
            } finally {
              handle.cancel();
            }
          })(),
        };
      },
    };
  }
}
