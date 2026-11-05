import { expect, it, vi } from 'vitest';

import { RESEARCHER_SPEC } from '../../core/src/agentSpec.js';
import { compileAgent } from '../src/agentCompiler.js';
import {
  RESEARCH_BYTES_PER_TOKEN,
  RESEARCH_REQUEST_MAX_BYTES,
  RESEARCH_REQUEST_OVERHEAD_TOKENS,
} from '../src/constants.js';
import type { ExecutionRequest, Executor } from '../src/executors/executor.js';
import { researchCost, researchPolicy } from '../src/researchPolicy.js';
import { researchBudget } from '../src/researchRuntime.js';

const request = (): ExecutionRequest => ({
  executionId: 'fixture',
  projectId: 'fixture',
  taskKey: 'review',
  role: 'researcher',
  agentSpec: RESEARCHER_SPEC,
  prompt: '',
  flags: [],
  worktreePath: '.',
  timeoutMin: 1,
  taskData: { task: { items: ['Inspect implementation'] }, outputSchema: { type: 'object' } },
});
const inputSize = (req: ExecutionRequest) => {
  const compiled = compileAgent(req.agentSpec!, req.role, req.taskData!);
  return Math.ceil(
    (Buffer.byteLength(compiled.systemPrompt) + Buffer.byteLength(compiled.context)) /
      RESEARCH_BYTES_PER_TOKEN,
  );
};
const underlying = (tokens = 0, costUsd = 0): Executor => ({
  id: 'claude',
  start: vi.fn(() => ({
    cancel: vi.fn(),
    events: (async function* () {
      yield { type: 'usage' as const, inputTokens: tokens, outputTokens: 0 };
      yield { type: 'finished' as const, exitCode: 0, resultSummary: '{}', costUsd };
    })(),
  })),
});

it('preflights the compiled system prompt and schema as well as the context', () => {
  const req = request();
  req.taskData!.outputSchema = { type: 'object', description: 'schema text '.repeat(500) };
  const executor = underlying();
  const gaps: string[] = [];
  const budget = researchBudget(
    executor,
    researchPolicy('quick', { maxTokens: inputSize(req) + RESEARCH_REQUEST_OVERHEAD_TOKENS }),
    new AbortController(),
    gaps,
  );
  expect(() => budget.executor.start(req)).toThrow('input budget');
  expect(executor.start).not.toHaveBeenCalled();
  expect(gaps.join(' ')).toContain('output schema');
});

it.each(['tokens', 'cost'] as const)('checks remaining %s again before a retry', async (limit) => {
  const req = request();
  const estimate = inputSize(req) + RESEARCH_REQUEST_OVERHEAD_TOKENS;
  const executor = underlying(estimate, researchCost(estimate, 0) * 1.5);
  const policy = researchPolicy('quick', {
    maxTokens: limit === 'tokens' ? estimate * 2 : 100_000,
    maxCostUsd: limit === 'cost' ? researchCost(estimate, 0) * 3 : 1,
  });
  const budget = researchBudget(executor, policy, new AbortController(), []);
  for await (const event of budget.executor.start(req).events) void event;
  expect(() => budget.executor.start(req)).toThrow('input budget');
  expect(executor.start).toHaveBeenCalledTimes(1);
  expect(budget.stopReason).toContain('preflight');
});

it('bounds each request even when the total token and cost budgets are ample', () => {
  const req = request();
  req.taskData!.task = 'x'.repeat(RESEARCH_REQUEST_MAX_BYTES);
  const executor = underlying();
  const budget = researchBudget(
    executor,
    researchPolicy('deep', { modes: { deep: { maxTokens: 1_000_000 } } }),
    new AbortController(),
    [],
  );
  expect(() => budget.executor.start(req)).toThrow('input budget');
  expect(executor.start).not.toHaveBeenCalled();
});

it('lets a quick synthesis of four normal excerpts reach the model', () => {
  const req = request();
  req.taskData!.task = { sources: Array.from({ length: 4 }, () => 'x'.repeat(2500)) };
  const executor = underlying();
  researchBudget(executor, researchPolicy('quick', {}), new AbortController(), []).executor.start(
    req,
  );
  expect(executor.start).toHaveBeenCalledOnce();
});
