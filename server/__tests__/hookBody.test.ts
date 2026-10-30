import { describe, expect, it } from 'vitest';

import { MAX_HOOK_BODY_SIZE } from '../src/constants.js';
import { hookBody } from '../src/providers/hook/claude/hooks/hookBody.js';

const base = { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Read' };

describe('hook body size', () => {
  it('drops the unused tool_response so a screenshot result is not rejected with 413', () => {
    const body = hookBody({
      ...base,
      tool_input: { file_path: 'a.png' },
      tool_response: { image: 'x'.repeat(5 * MAX_HOOK_BODY_SIZE) },
    });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_HOOK_BODY_SIZE);
    expect(JSON.parse(body)).toEqual({ ...base, tool_input: { file_path: 'a.png' } });
  });

  it('keeps small tool_input intact and trims long strings only when over the limit', () => {
    expect(JSON.parse(hookBody({ ...base, tool_input: { command: 'ls' } })).tool_input).toEqual({
      command: 'ls',
    });
    const parsed = JSON.parse(
      hookBody({
        ...base,
        tool_name: 'Write',
        tool_input: { file_path: 'b.ts', content: 'y'.repeat(2 * MAX_HOOK_BODY_SIZE), nested: {} },
      }),
    );
    expect(parsed.tool_input.file_path).toBe('b.ts');
    expect(parsed.tool_input.content.length).toBeLessThan(MAX_HOOK_BODY_SIZE);
    expect(parsed.tool_input.nested).toBe('[omitted]');
  });
});
