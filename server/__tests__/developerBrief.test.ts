import { expect, it } from 'vitest';

import { developerBrief, type DeveloperRequest } from '../src/developer.js';

it('narrows QA author context without losing assigned ACs, scope or rework evidence', () => {
  const input = {
    task: { agentRole: 'qa-author', acceptanceRefs: ['AC-001'], changeZones: ['e2e/'] },
    approvedSpec: { acceptance: [{ id: 'AC-001' }, { id: 'AC-002' }], rules: ['constraint'] },
    design: 'unrelated full feature design'.repeat(100),
    designSha: 'immutable-design',
    previousFailure: { reason: 'test failure' },
    reviewFindings: [{ summary: 'repair assertion' }],
  } as unknown as DeveloperRequest;
  const original = JSON.stringify(input);
  const brief = JSON.parse(developerBrief(input));
  expect(brief.design).toBeUndefined();
  expect(brief.approvedSpec.acceptance).toEqual([{ id: 'AC-001' }]);
  expect(brief.approvedSpec.rules).toEqual(['constraint']);
  for (const key of ['task', 'designSha', 'previousFailure', 'reviewFindings'] as const)
    expect(brief[key]).toEqual(input[key]);
  expect(JSON.stringify(input)).toBe(original);
  expect(developerBrief(input).length).toBeLessThan(original.length);
  expect(
    developerBrief({ ...input, task: { ...input.task, agentRole: 'developer', type: 'code' } }),
  ).toBe(
    JSON.stringify({ ...input, task: { ...input.task, agentRole: 'developer', type: 'code' } }),
  );
});
