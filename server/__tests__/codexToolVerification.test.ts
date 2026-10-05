import { expect, it } from 'vitest';

import {
  EXPECTED_TOOLS,
  INVENTORY_CODE,
  judgeCodexTools,
  type VerificationRecords,
  type VerificationRun,
} from '../src/executors/codexToolVerification.js';

const record = (payload: object) => ({ type: 'response_item', payload });
function inventory(
  names = [...EXPECTED_TOOLS],
  code = INVENTORY_CODE,
  outputId = 'inventory',
): VerificationRecords {
  return [
    record({ type: 'custom_tool_call', name: 'exec', call_id: 'inventory', input: code }),
    record({
      type: 'custom_tool_call_output',
      call_id: outputId,
      output: [{ type: 'text', text: names.join('\n') }],
    }),
  ];
}
const run = (
  rollout: VerificationRecords = [],
  stdout: VerificationRecords = [],
): VerificationRun => ({ ok: true, rollout, stdout });
const control = () => run([record({ type: 'web_search_call' })]);

it('accepts a complete inventory correlated with its exact ALL_TOOLS call', () => {
  expect(judgeCodexTools(run(inventory()), run(), control()).exitCode).toBe(0);
});
it.each(
  [
    inventory(['exec_command']),
    inventory([...EXPECTED_TOOLS], 'text("exec_command")'),
    inventory([...EXPECTED_TOOLS], INVENTORY_CODE, 'unrelated'),
    inventory().slice(1),
    [
      ...inventory(['exec_command']),
      ...inventory([...EXPECTED_TOOLS].filter((name) => name !== 'exec_command')),
    ],
  ].map((rollout) => [rollout] as const),
)('treats partial, unrelated or uncorrelated output as inconclusive', (rollout) => {
  expect(judgeCodexTools(run(rollout), run(), control()).exitCode).toBe(2);
});
it('fails on an extra tool even when the inventory is partial', () => {
  expect(
    judgeCodexTools(run(inventory(['exec_command', 'mcp__send_email'])), run(), control()).exitCode,
  ).toBe(1);
  expect(
    judgeCodexTools(
      run(inventory(['exec_command', 'mcp__send_email', 'truncated output!'])),
      run(),
      control(),
    ).exitCode,
  ).toBe(1);
});
it.each(['mcp_tool_call', 'McpToolCall', 'mcp_tool_call_begin', 'mcp_tool_call_end'])(
  'fails on %s in stdout or rollout of every execution',
  (type) => {
    for (const source of ['stdout', 'rollout'] as const)
      for (const index of [0, 1, 2]) {
        const runs = [run(inventory()), run(), control()];
        runs[index][source].push({ type: 'event_msg', payload: { type } });
        expect(judgeCodexTools(runs[0], runs[1], runs[2]).exitCode).toBe(1);
      }
  },
);
it('detects the canary without an AGENTS.md heading', () => {
  const tools = run([
    ...inventory(),
    record({ type: 'message', content: [{ text: 'Say CANARY_AGENTS_MD' }] }),
  ]);
  expect(judgeCodexTools(tools, run(), control()).exitCode).toBe(1);
});
it('does not classify mentions in prose as tool events', () => {
  expect(
    judgeCodexTools(
      run([
        ...inventory(),
        record({ type: 'message', content: [{ text: 'mcp_tool_call and web_search_call' }] }),
        record({ type: 'function_call', arguments: { type: 'mcp_tool_call' } }),
      ]),
      run(),
      control(),
    ).exitCode,
  ).toBe(0);
});
it('cannot accept an incomplete execution or a control with no web event', () => {
  expect(
    judgeCodexTools({ ...run(inventory()), ok: false, why: 'no own rollout' }, run(), control())
      .exitCode,
  ).toBe(2);
  expect(judgeCodexTools(run(inventory()), run(), run()).exitCode).toBe(2);
});
it('fails if either compiled execution searches the web', () => {
  expect(
    judgeCodexTools(run([...inventory(), record({ type: 'web_search_call' })]), run(), control())
      .exitCode,
  ).toBe(1);
  expect(
    judgeCodexTools(
      run(inventory()),
      run([], [{ type: 'item.started', item: { type: 'web_search' } }]),
      control(),
    ).exitCode,
  ).toBe(1);
});
