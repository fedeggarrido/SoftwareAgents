import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as contract from '../../core/schemas/review-report.schema.json';
import type { ReviewReport } from '../../core/src/reviewReport.js';
import { reviewerBrief, type ReviewerRequest, validateReview } from '../src/reviewer.js';
import {
  ReviewCycle,
  reviewPassAllowance,
  reviewPassSelection,
  synthesizeReviews,
} from '../src/reviewPasses.js';
import { compileSchema, validateSchema } from '../src/schemaValidation.js';
import type { UsageEntry } from '../src/usageLedger.js';

vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  execFileSync: (command: string, args: string[]) => {
    if (command === 'git' && args[0] === 'show') return 'export const value = 1;\n';
    throw new Error('Unexpected subprocess in review validation unit test');
  },
}));

const finding: ReviewReport['findings'][number] = {
  severity: 'major',
  category: 'security',
  file: 'code.ts',
  line: 1,
  evidence: 'Input from an unauthenticated caller reaches the write operation.',
  summary: 'security: unauthorized write',
  suggestion: 'Validate the caller before writing.',
};
const approve: ReviewReport = { verdict: 'approve', findings: [] };
const reject: ReviewReport = { verdict: 'request_changes', findings: [finding] };
function pass(
  report: ReviewReport,
  executionId = 'first',
): NonNullable<ReviewReport['passes']>[number] {
  return {
    pass: 'bugs_security',
    report,
    originalReport: structuredClone(report),
    executionId,
    executor: 'claude',
  };
}
function usage(executionId: string, costUsd: number | null): UsageEntry {
  return {
    executionId,
    taskKey: 'FEAT-001-T01',
    featureKey: 'FEAT-001',
    day: new Date().toISOString().slice(0, 10),
    startedAt: '',
    endedAt: '',
    durationMs: 1,
    attempt: 1,
    executor: 'claude',
    model: 'test-model',
    tier: 'standard',
    inputTokens: 10,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    cacheHitRate: 0,
    costUsd,
    quotaBefore: null,
    quotaAfter: null,
  };
}

describe('review pass policy', () => {
  it.each(['S', 'M', 'L'] as const)('uses canonical task size %s', (size) => {
    expect(reviewPassSelection({ workType: 'review', size })).toEqual(
      size === 'S' ? ['single'] : ['bugs_security', 'quality_structure'],
    );
  });
  it('uses the tier policy fallback for legacy missing estimates', () => {
    expect(reviewPassSelection({})).toEqual(['bugs_security', 'quality_structure']);
  });
  it('deduplicates by location and category, retaining highest effective severity', () => {
    const other: ReviewReport = {
      verdict: 'request_changes',
      findings: [
        { ...finding, severity: 'blocker', summary: 'A stronger supported finding' },
        { ...finding, category: 'types' },
        { ...finding, line: 2 },
      ],
    };
    const report = synthesizeReviews([pass(reject), pass(other, 'second')]);
    expect(report.findings).toHaveLength(3);
    expect(report.findings[0]).toMatchObject({
      severity: 'blocker',
      category: 'security',
      line: 1,
    });
    expect(report.verdict).toBe('request_changes');
    expect(report.passes?.[0].originalReport).toEqual(reject);
    expect(validateSchema(compileSchema<ReviewReport>(contract), report)).toEqual(report);
  });
  it('retains an effective rejection from either pass and the worst AC coverage', () => {
    const missing: ReviewReport = {
      verdict: 'request_changes',
      findings: [],
      acCoverage: [{ ac: 'AC-001', status: 'missing' }],
    };
    const covered: ReviewReport = { ...approve, acCoverage: [{ ac: 'AC-001', status: 'covered' }] };
    for (const passes of [
      [pass(missing), pass(covered)],
      [pass(covered), pass(missing)],
    ]) {
      expect(synthesizeReviews(passes)).toMatchObject({
        verdict: 'request_changes',
        acCoverage: missing.acCoverage,
      });
    }
  });
  it('keeps small tasks on one pass with auditable raw content', () => {
    const cycle = new ReviewCycle(reviewPassSelection({ workType: 'review', size: 'S' }));
    cycle.accept(approve, JSON.stringify(approve), 'first', 'claude');
    expect(cycle.secondPass).toBe(false);
    expect(cycle.report()).toMatchObject({
      verdict: 'approve',
      passes: [{ pass: 'single', originalReport: approve }],
    });
  });
  it('reserves the second pass within 20% of the measured task baseline', () => {
    expect(
      reviewPassAllowance([usage('developer', 9), usage('first', 1)], 'first', undefined, 2),
    ).toEqual({ maxCostUsd: 2 });
    expect(reviewPassAllowance([usage('first', 1)], 'first', undefined, 1)).toHaveProperty(
      'reason',
    );
  });
  it('subtracts previous quality passes from the task allowance across rework rounds', () => {
    const entries = [usage('developer', 9), usage('first', 1), usage('previous-extra', 1.5)];
    expect(reviewPassAllowance(entries, 'first', undefined, 3, ['previous-extra'])).toHaveProperty(
      'reason',
    );
  });
  it('requests cancellation at the cost allowance or when accounting becomes unknown', () => {
    const cycle = new ReviewCycle(['bugs_security', 'quality_structure']);
    cycle.accept(approve, JSON.stringify(approve), 'first', 'claude');
    cycle.allowance = { maxCostUsd: 2 };
    const attributes = {
      'gen_ai.response.model': 'test-model',
      'gen_ai.usage.input_tokens': 1,
      'gen_ai.usage.output_tokens': 0,
      'gen_ai.usage.cache_read.input_tokens': 0,
      'gen_ai.usage.cache_creation.input_tokens': 0,
    };
    const prices = { 'test-model': { input: 1_000_000, output: 1_000_000 } };
    expect(cycle.observeCost(attributes, prices)).toBe(false);
    expect(cycle.observeCost({ ...attributes, 'gen_ai.usage.input_tokens': 2 }, prices)).toBe(true);
    expect(cycle.observeCost(attributes, undefined)).toBe(true);
    expect(cycle.report().runtimeNotes?.join(' ')).toContain('cancellation');
  });
  it.each([null, 0])('records fallback when first-pass cost is %s', (cost) => {
    const cycle = new ReviewCycle(['bugs_security', 'quality_structure']);
    cycle.accept(approve, JSON.stringify(approve), 'first', 'claude');
    const allowance = reviewPassAllowance([usage('first', cost)], 'first', undefined, 1);
    expect('reason' in allowance).toBe(true);
    if ('reason' in allowance)
      expect(cycle.fallback(allowance.reason).runtimeNotes?.join(' ')).toContain('cost cap');
  });
  it('records quota fallback without changing the effective verdict', () => {
    const cycle = new ReviewCycle(['bugs_security', 'quality_structure']);
    cycle.accept(reject, JSON.stringify(reject), 'first', 'claude');
    expect(cycle.fallback('quota unavailable')).toMatchObject({
      verdict: 'request_changes',
      runtimeNotes: [expect.stringContaining('quota unavailable')],
    });
  });
  it('respects operator cost and attempt budgets and unknown baseline costs', () => {
    const entries = [usage('developer', 9), usage('first', 1)];
    for (const budgets of [{ maxCostUsd: 10.5 }, { maxAttemptsPerTask: 2 }])
      expect(reviewPassAllowance(entries, 'first', budgets, 2)).toHaveProperty('reason');
    expect(
      reviewPassAllowance([usage('developer', null), usage('first', 1)], 'first', undefined, 2),
    ).toHaveProperty('reason');
  });
});

describe('validated independent review content', () => {
  let root: string;
  let input: ReviewerRequest;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-passes-'));
    const sha = 'a'.repeat(40);
    input = {
      key: 'FEAT-001',
      featureSha: sha,
      designSha: sha,
      design: 'test design',
      approvedSpec: {
        apiVersion: 'softwareagents.io/v1alpha1',
        kind: 'FeatureSpec',
        key: 'FEAT-001',
        version: '1',
        status: 'approved',
        title: 'Test',
        goal: 'Test reviews',
        userValue: 'Test',
        actors: [],
        flows: [],
        rules: [],
        edgeCases: [],
        acceptance: [],
        openQuestions: [],
        links: { adr: [], clickup: [] },
      },
      developerExecutor: 'codex',
      diff: '+export const value = 1;',
      worktree: root,
      files: ['code.ts'],
      changedTestFiles: [],
      reviewRef: { base: sha, sha, branch: 'main' },
      task: {
        key: 'FEAT-001-T01',
        type: 'code',
        title: 'Test',
        description: 'Test reviews',
        acceptanceRefs: ['AC-001'],
        dependsOn: [],
        agentRole: 'developer',
        size: 'M',
      },
    };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('merges after evidence downgrade and preserves raw reports', () => {
    const unsupported: ReviewReport = {
      verdict: 'request_changes',
      findings: [{ ...finding, evidence: '' }],
    };
    const cycle = new ReviewCycle(['bugs_security', 'quality_structure']);
    for (const [id, raw] of [
      ['first', unsupported],
      ['second', approve],
    ] as const) {
      const source = JSON.stringify(raw);
      cycle.accept(validateReview(source, input), source, id, 'claude');
    }
    expect(cycle.report()).toMatchObject({
      verdict: 'approve',
      findings: [{ severity: 'minor', downgradeReasons: ['missing evidence'] }],
      passes: [{ originalReport: unsupported }, { originalReport: approve }],
    });
    expect(validateSchema(compileSchema<ReviewReport>(contract), cycle.report())).toBeTruthy();
  });
  it('passes no other report to the second brief and rejects runtime audit fields at ingress', () => {
    const brief = JSON.parse(reviewerBrief(input, [], 'quality_structure'));
    expect(brief.reviewPass).toBe('quality_structure');
    expect(brief).not.toHaveProperty('passes');
    for (const field of ['runtimeNotes', 'passes', 'originalReport'])
      expect(() => validateReview(JSON.stringify({ ...approve, [field]: [] }), input)).toThrow();
    expect(() =>
      validateReview(
        JSON.stringify({ ...reject, findings: [{ ...finding, downgradeReasons: [] }] }),
        input,
      ),
    ).toThrow();
  });
});
