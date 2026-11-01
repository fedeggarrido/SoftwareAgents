import { WEB_SCOUT_SPEC } from '../../core/src/agentSpec.js';
import { validateAgentOutput } from './agentCompiler.js';
import type { ExecutionRequest, Executor } from './executors/executor.js';

export const SCOUT_MAX_URLS = 12;
export function scoutSchema(limit: number): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['candidates'],
    properties: {
      candidates: {
        type: 'array',
        maxItems: Math.min(limit, SCOUT_MAX_URLS),
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['url', 'title', 'reason'],
          properties: {
            url: {
              type: 'string',
              maxLength: 2048,
              pattern: '^https?://[^/@\\s?#]+(?:[/?#][^\\s]*)?$',
            },
            title: { type: 'string', minLength: 1, maxLength: 300 },
            reason: { type: 'string', minLength: 1, maxLength: 240 },
          },
        },
      },
    },
  };
}
/** Parse the entire response. No prose, fences, titles or reasons cross the boundary. */
export function scoutUrls(output: string, limit: number): string[] {
  const value: unknown = JSON.parse(output);
  if (!validateAgentOutput(scoutSchema(limit), value)) throw new Error('Invalid scout candidates');
  return [
    ...new Set(
      (value as { candidates: { url: string }[] }).candidates.map(({ url }) => {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
          throw new Error('Invalid scout URL');
        return parsed.href;
      }),
    ),
  ];
}
export async function discoverUrls(
  executor: Executor,
  request: Omit<ExecutionRequest, 'role' | 'agentSpec' | 'taskData'>,
  question: string,
  limit: number,
  maxTokens: number,
  signal: AbortSignal,
): Promise<{ urls: string[]; tokens: number }> {
  if (executor.id !== 'claude') throw new Error('Web scout requires Claude');
  signal.throwIfAborted();
  const handle = executor.start({
    ...request,
    role: 'web-scout',
    agentSpec: WEB_SCOUT_SPEC,
    taskData: { task: { question }, outputSchema: scoutSchema(limit) },
  });
  const cancel = () => handle.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  let tokens = 0,
    observed = false,
    output: string | undefined,
    failure: string | undefined;
  try {
    for await (const event of handle.events) {
      if (event.type === 'usage') {
        observed = true;
        if (![event.inputTokens, event.outputTokens].every((n) => Number.isFinite(n) && n >= 0)) {
          failure = 'Invalid scout usage';
          handle.cancel();
        } else tokens += event.inputTokens + event.outputTokens;
        if (tokens >= maxTokens) {
          failure = 'Scout token budget exhausted';
          handle.cancel();
        }
      }
      if (event.type === 'finished') {
        if (event.exitCode !== 0) failure ??= 'Scout execution failed';
        output = event.resultSummary;
      }
    }
    signal.throwIfAborted();
    if (failure) throw new Error(failure);
    if (!observed || !output) throw new Error('Scout output or usage unavailable');
    return { urls: scoutUrls(output, limit), tokens };
  } finally {
    handle.cancel();
    signal.removeEventListener('abort', cancel);
  }
}
