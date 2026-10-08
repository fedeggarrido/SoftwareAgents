import type { AgentSpec } from '../../../core/src/agentSpec.js';
import type { CapacitySnapshot } from '../../../core/src/capacity.js';
import type { AgentCompilerTask } from '../agentCompiler.js';
export type ExecutorId = 'claude' | 'codex';

/** Caller must authorize execution externally; CLI adapters compile bounded AgentSpec input. */
export interface ExecutionRequest {
  executionId: string;
  projectId: string;
  taskKey: string;
  role: string;
  prompt: string;
  flags: readonly string[];
  agentSpec?: AgentSpec;
  /** Optional prepared context; legacy Developer requests use prompt as untrusted task data. */
  taskData?: AgentCompilerTask;
  worktreePath: string;
  model?: string;
  timeoutMin: number;
  /** Trusted runtime callback: durable supervisor registration before CLI launch. */
  registerProcess?: (pid: number) => void;
}

export type ExecutionEvent =
  | { type: 'started'; sessionId: string; pid: number; startedAt: string }
  | { type: 'toolUse'; toolId: string; toolName: string; input: unknown }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'rateLimit'; retryAfterSec: number; message: string; capacity?: CapacitySnapshot }
  | { type: 'output'; text: string; stream: 'stdout' | 'stderr' }
  | { type: 'finished'; exitCode: number; resultSummary: string };

export interface ExecutionHandle {
  /** Reserved before a lazy CLI launch; registry persists it before draining events. */
  readonly sessionId?: string;
  /** One consumer must drain events through finished; persistence precedes delivery. */
  readonly events: AsyncIterable<ExecutionEvent>;
  /** Idempotent; harmless after finished. Cancellation is reported by finished. */
  cancel(): void;
}

export interface Executor {
  readonly id: ExecutorId;
  start(req: ExecutionRequest): ExecutionHandle;
}
