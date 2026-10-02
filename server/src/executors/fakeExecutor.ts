import type {
  ExecutionEvent,
  ExecutionHandle,
  ExecutionRequest,
  Executor,
  ExecutorId,
} from './executor.js';

/** Deterministic in-process Executor; no CLI, hooks, profile or office dependencies. */
export class FakeExecutor implements Executor {
  constructor(public readonly id: ExecutorId) {}

  start(req: ExecutionRequest): ExecutionHandle {
    let cancelled = false;
    const id = this.id;
    return {
      cancel() {
        cancelled = true;
      },
      events: (async function* (): AsyncGenerator<ExecutionEvent> {
        yield {
          type: 'started',
          sessionId: `fake-${id}-${req.executionId}`,
          pid: 1,
          startedAt: '2026-01-01T00:00:00.000Z',
        };
        if (!cancelled) {
          yield {
            type: 'toolUse',
            toolId: 'tool-1',
            toolName: 'read_file',
            input: { path: 'README.md' },
          };
          yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
          yield { type: 'rateLimit', retryAfterSec: 1, message: 'Synthetic rate limit' };
          yield { type: 'output', text: 'Fake result', stream: 'stdout' };
        }
        yield {
          type: 'finished',
          exitCode: cancelled ? 130 : 0,
          resultSummary: cancelled ? 'Cancelled' : 'Fake result',
        };
      })(),
    };
  }
}
