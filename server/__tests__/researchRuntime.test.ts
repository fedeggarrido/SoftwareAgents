import { expect, it, vi } from 'vitest';

import { RESEARCHER_SPEC } from '../../core/src/agentSpec.js';
import { compileAgent } from '../src/agentCompiler.js';
import { RESEARCH_REQUEST_MAX_BYTES } from '../src/constants.js';
import type { ExecutionHandle, ExecutionRequest, Executor } from '../src/executors/executor.js';
import { FEATURE_RESEARCH_SCHEMA } from '../src/featureResearch.js';
import { researchPolicy } from '../src/researchPolicy.js';
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
// Counted offline with tiktoken 0.13.0: 256 byte tokens, plus the single merge " a",
// pat_str = "[\\s\\S]+" and no special tokens or downloaded vocabulary.
// Counts are independent of runtime admission constants, not claims about Claude's tokenizer.
const dense = { text: ' a'.repeat(16_906), tokens: 16_906 };
const excerpt = { text: 'Export returns stored events. '.repeat(80), tokens: 2_400 };
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
  req.taskData!.outputSchema = { type: 'object', description: 'schema text '.repeat(3000) };
  const compiled = compileAgent(req.agentSpec!, req.role, req.taskData!);
  expect(Buffer.byteLength(compiled.context)).toBeLessThan(16_000);
  expect(Buffer.byteLength(compiled.systemPrompt)).toBeGreaterThan(32_000);
  const executor = underlying();
  const gaps: string[] = [];
  const budget = researchBudget(executor, researchPolicy('quick', {}), new AbortController(), gaps);
  expect(() => budget.executor.start(req)).toThrow('input budget');
  expect(executor.start).not.toHaveBeenCalled();
  expect(gaps.join(' ')).toContain('output schema');
});

it.each(['tokens', 'cost'] as const)('checks remaining %s again before a retry', async (limit) => {
  const req = request();
  req.taskData!.task = { sources: Array.from({ length: 4 }, () => excerpt.text) };
  const executor = underlying(excerpt.tokens * 4, 0.04);
  const policy = researchPolicy('quick', {
    // At 0.10 USD the first input fits the 0.08 allowance; after 0.04 spent it does not.
    maxCostUsd: limit === 'cost' ? 0.1 : 1,
    modes: { quick: { maxTokens: limit === 'cost' ? 100_000 : 16_000 } },
  });
  const budget = researchBudget(executor, policy, new AbortController(), []);
  for await (const event of budget.executor.start(req).events) void event;
  expect(budget.usedTokens).toBe(9_600);
  expect(budget.usedEstimateUsd).toBe(0.04);
  if (limit === 'cost') expect(policy.maxTokens - budget.usedTokens).toBe(90_400);
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

it('refuses independently counted token-dense input before any model call or usage event', async () => {
  const req = request();
  req.taskData!.task = { diff: dense.text };
  const compiled = compileAgent(req.agentSpec!, req.role, req.taskData!);
  const bytes = Buffer.byteLength(compiled.systemPrompt) + Buffer.byteLength(compiled.context);
  // Fixed all-ASCII compiled fixture: ceil(36,719 / 2) + 1,024 = 19,384.
  // Independent BPE count above: its diff alone is 16,906 tokens (> quick's 16,000).
  expect(bytes).toBe(36_719);
  expect(Math.ceil(bytes / 2) + 1_024).toBe(19_384);
  const executor = underlying(dense.tokens);
  const abort = new AbortController();
  const budget = researchBudget(executor, researchPolicy('quick', {}), abort, []);
  expect(dense.tokens).toBeGreaterThan(16_000);
  let handle: ExecutionHandle | undefined;
  let refused = false;
  try {
    handle = budget.executor.start(req);
  } catch {
    refused = true;
  }
  // If admission regresses, consume usage: cancellation after launch cannot fix it.
  if (handle) for await (const event of handle.events) void event;
  expect(refused).toBe(true);
  expect(executor.start).not.toHaveBeenCalled();
  expect(budget.usedTokens).toBe(0);
  expect(abort.signal.aborted).toBe(false);
  expect(budget.stopReason).toContain('preflight');
  expect(budget.stopReason).toContain('use deep mode or reduce the input');
});

it('lets a quick synthesis of four normal excerpts reach the model and accounts its events', async () => {
  const req = request();
  req.taskData!.task = { sources: Array.from({ length: 4 }, () => excerpt.text) };
  const executor = underlying(excerpt.tokens * 4, 0.04);
  const budget = researchBudget(executor, researchPolicy('quick', {}), new AbortController(), []);
  for await (const event of budget.executor.start(req).events) void event;
  expect(executor.start).toHaveBeenCalledOnce();
  expect(budget.usedTokens).toBe(9_600);
  expect(budget.usedEstimateUsd).toBe(0.04);
  expect(budget.stopReason).toBeUndefined();
});

it('admits a 17,557-byte quick feature review with 60 added lines and its real schema', async () => {
  const req = request();
  req.agentSpec = { ...RESEARCHER_SPEC, outputs: ['FeatureResearchReview'] };
  const lines = Array.from({ length: 60 }, (_, i) => `export const available${i} = true;`);
  req.taskData = {
    outputSchema: FEATURE_RESEARCH_SCHEMA,
    task: {
      kind: 'feature-research-review',
      provenance: 'untrusted-external',
      key: 'FEAT-001',
      branch: 'sa/FEAT-001-integration',
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
      items: [
        { id: 'AC-001', kind: 'acceptance', text: 'Export returns stored events.' },
        {
          id: 'design:architecture',
          kind: 'plan',
          // Fixed plan size, independent of production admission constants.
          text:
            'Use a read-only export module.' +
            ' Cover empty logs and preserve stored events.'.repeat(200).slice(0, 4_549),
        },
        { id: 'FEAT-001-T01', kind: 'plan', text: 'Implement and test export.' },
      ],
      diff:
        'diff --git a/src/export.ts b/src/export.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/export.ts\n@@ -0,0 +1,60 @@\n' +
        lines.map((line) => '+' + line + '\n').join(''),
      evidence: lines.map((quote, i) => ({ ref: `branch:src/export.ts:${i + 1}`, quote })),
      deliveryRefs: lines.map((_, i) => `branch:src/export.ts:${i + 1}`),
      preResearch: null,
      externalRefs: [],
    },
  };
  const compiled = compileAgent(req.agentSpec, req.role, req.taskData);
  const bytes = Buffer.byteLength(compiled.systemPrompt) + Buffer.byteLength(compiled.context);
  // All ASCII: ceil(17,557 / 2) + 1,024 = 9,803, leaving 6,197 for output.
  // Fixed numbers are independent of production conversion/overhead constants.
  expect(bytes).toBe(17_557);
  expect(Math.ceil(bytes / 2) + 1_024).toBe(9_803);
  const executor = underlying();
  const budget = researchBudget(executor, researchPolicy('quick', {}), new AbortController(), []);
  for await (const event of budget.executor.start(req).events) void event;
  expect(executor.start).toHaveBeenCalledOnce();
});

it('reserves one token per non-ASCII byte and gives an actionable refusal', () => {
  const req = request();
  req.taskData!.task = 'é'.repeat(7_000); // 14,000 UTF-8 bytes before compiled framing.
  const executor = underlying();
  const budget = researchBudget(executor, researchPolicy('quick', {}), new AbortController(), []);
  expect(() => budget.executor.start(req)).toThrow('use deep mode or reduce the input');
  expect(executor.start).not.toHaveBeenCalled();
});
