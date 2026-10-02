export type ExecutorId = 'claude' | 'codex';

/** Already compiled input; policy and prompt compilation belong to the caller. */
export interface ExecutionRequest {
  executionId: string;
  projectId: string;
  taskKey: string;
  role: string;
  prompt: string;
  flags: readonly string[];
  worktreePath: string;
  model?: string;
  timeoutMin: number;
}

export type ExecutionEvent =
  | { type: 'started'; sessionId: string; pid: number; startedAt: string }
  | { type: 'toolUse'; toolId: string; toolName: string; input: unknown }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'rateLimit'; retryAfterSec: number; message: string }
  | { type: 'output'; text: string; stream: 'stdout' | 'stderr' }
  | { type: 'finished'; exitCode: number; resultSummary: string };

export interface ExecutionHandle {
  /** One consumer must drain events through finished; persistence precedes delivery. */
  readonly events: AsyncIterable<ExecutionEvent>;
  /** Idempotent; harmless after finished. Cancellation is reported by finished. */
  cancel(): void;
}

export interface Executor {
  readonly id: ExecutorId;
  start(req: ExecutionRequest): ExecutionHandle;
}
