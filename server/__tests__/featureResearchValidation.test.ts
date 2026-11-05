import { expect, it } from 'vitest';

import { type FeatureResearchInput, validateFeatureResearch } from '../src/featureResearch.js';

// Isolate validation from the Git fixture so trust-boundary regressions can run without processes.
const input = (): FeatureResearchInput => ({
  key: 'FEAT-001',
  branch: 'fixture',
  base: 'base',
  head: 'head',
  sources: { requirements: 'Promise', design: null, dag: null },
  preResearch: null,
  bibliography: [],
  diff: '',
  items: [
    { id: 'AC-001', kind: 'acceptance', text: 'Export visible' },
    { id: 'design:tests', kind: 'plan', text: 'Test export' },
  ],
  evidence: [
    { ref: 'branch:src/export.ts:1', quote: 'export const available = true;' },
    { ref: 'branch:plan.yaml:1', quote: 'then: Export is visible' },
    { ref: 'src/nonexistent.ts:1', quote: 'External claim' },
    { ref: 'external:0', quote: 'External claim' },
  ],
  branchEvidence: new Map([['branch:src/export.ts:1', 'export const available = true;']]),
});

it.each(['src/nonexistent.ts:1', 'external:0', 'branch:src/export.ts:1'])(
  'rejects external delivery claims at %s against the separate branch map',
  (ref) => {
    const context = input();
    context.evidence.push({ ref, quote: 'External claim' });
    const report = validateFeatureResearch(
      JSON.stringify({
        coverage: [
          {
            id: 'AC-001',
            status: 'delivered',
            explanation: 'Claim',
            evidence: [{ ref, quote: 'External claim' }],
          },
        ],
        proposals: [],
      }),
      context,
    );
    expect(report.coverage[0].status).toBe('not verifiable');
  },
);

it.each(['delivered', 'partial', 'missing'])('downgrades promise-only %s claims', (status) => {
  const context = input();
  const report = validateFeatureResearch(
    JSON.stringify({
      coverage: [
        { id: 'AC-001', status, explanation: 'Plan only', evidence: [context.evidence[1]] },
      ],
      proposals: [],
    }),
    context,
  );
  expect(report.coverage[0].status).toBe('not verifiable');
});

it('requires a citation on each item even when another item cites a real code line', () => {
  const context = input();
  const report = validateFeatureResearch(
    JSON.stringify({
      coverage: [
        {
          id: 'AC-001',
          status: 'delivered',
          explanation: 'Code pointer',
          evidence: [context.evidence[0]],
        },
        {
          id: 'design:tests',
          status: 'delivered',
          explanation: 'Assumed from other item',
          evidence: [],
        },
      ],
      proposals: [],
    }),
    context,
  );
  expect(report.coverage.map((row) => row.status)).toEqual(['delivered', 'not verifiable']);
});
