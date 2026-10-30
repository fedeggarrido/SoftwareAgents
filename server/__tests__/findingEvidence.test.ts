import { execFileSync } from 'child_process';
import { describe, expect, it, vi } from 'vitest';

import { type FindingDecision, findingPrecision } from '../src/findingPrecision.js';
import { validateTestReport } from '../src/qa.js';
import { type ReviewerRequest, validateReview } from '../src/reviewer.js';

vi.mock('child_process', () => ({ execFileSync: vi.fn(() => 'first\nsecond\n') }));

const input = {
  files: ['a.ts'],
  worktree: '.',
  reviewRef: { sha: 'a'.repeat(40) },
  task: { acceptanceRefs: [] },
} as unknown as ReviewerRequest;
describe('finding evidence', () => {
  it('keeps request_changes when the runtime knows of a missing AC despite downgrades', () => {
    const report = validateReview(
      JSON.stringify({
        verdict: 'request_changes',
        findings: [
          { severity: 'major', file: 'a.ts', summary: 'AC-001 untested', suggestion: 'test it' },
        ],
        acCoverage: [{ ac: 'AC-001', status: 'missing' }],
      }),
      { ...input, task: { acceptanceRefs: ['AC-001'] } } as ReviewerRequest,
    );
    expect(report.findings[0].severity).toBe('minor');
    expect(report.verdict).toBe('request_changes');
  });
  it('keeps request_changes when a changed task test is not executed', () => {
    const report = validateReview(
      JSON.stringify({
        verdict: 'request_changes',
        findings: [
          { severity: 'major', file: 'a.ts', summary: 'test not run', suggestion: 'run it' },
        ],
      }),
      { ...input, files: ['a.ts', 'nowhere/orphan.test.ts'] } as ReviewerRequest,
    );
    expect(report.verdict).toBe('request_changes');
  });
  it.each(['test fails', 'TODO', '   '])(
    'downgrades generic QA reproduction: %s',
    (reproduction) => {
      const result = validateTestReport(
        JSON.stringify({
          verdict: 'fail',
          acceptance: [{ ac: 'AC-001', status: 'fail', evidence: 'source inspection' }],
          commands: [],
          defects: [{ ac: 'AC-001', severity: 'major', summary: 'bug', reproduction }],
        }),
        { ...input, task: { acceptanceRefs: ['AC-001'] } } as ReviewerRequest,
        [],
      );
      expect(result.defects[0].severity).toBe('minor');
      expect(result.verdict).toBe('not_tested');
      expect(result.originalReport?.verdict).toBe('fail');
    },
  );
  it('downgrades QA defects linked to an unknown AC', () => {
    const result = validateTestReport(
      JSON.stringify({
        verdict: 'fail',
        acceptance: [{ ac: 'AC-001', status: 'fail', evidence: 'source inspection' }],
        commands: [],
        defects: [
          {
            ac: 'AC-999',
            severity: 'major',
            summary: 'bug',
            reproduction: 'Open empty audit: throws instead of showing empty state',
          },
        ],
      }),
      { ...input, task: { acceptanceRefs: ['AC-001'] } } as ReviewerRequest,
      [],
    );
    expect(result.defects[0].downgradeReasons).toContain('unknown AC');
    expect(result.verdict).toBe('not_tested');
  });
  it.each([
    [{}, 'missing evidence'],
    [{ evidence: 'input 1 produces incorrect output 2', file: 'outside.ts' }, 'file not in diff'],
    [{ evidence: 'input 1 produces incorrect output 2', line: 3 }, 'line out of range'],
  ])('downgrades unsupported blockers and preserves the model report', (override, reason) => {
    const report = validateReview(
      JSON.stringify({
        verdict: 'request_changes',
        findings: [
          {
            severity: 'major',
            file: 'a.ts',
            line: 1,
            summary: 'bug',
            suggestion: 'fix',
            ...override,
          },
        ],
      }),
      input,
    );
    expect(report.verdict).toBe('approve');
    expect(report.findings[0].severity).toBe('minor');
    expect(report.findings[0].downgradeReasons).toContain(reason);
    expect(report.originalReport?.verdict).toBe('request_changes');
    expect(report.runtimeNotes?.length).toBe(1);
  });
  it('keeps a supported major and checks the pinned SHA', () => {
    const report = validateReview(
      JSON.stringify({
        verdict: 'request_changes',
        findings: [
          {
            severity: 'major',
            file: 'a.ts',
            line: 2,
            evidence: '  test input 1 returns 2 instead of 3  ',
            summary: 'bug',
            suggestion: 'fix',
          },
        ],
      }),
      input,
    );
    expect(report.findings[0].evidence).toBe('test input 1 returns 2 instead of 3');
    expect(report.verdict).toBe('request_changes');
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['show', `${input.reviewRef.sha}:a.ts`],
      expect.anything(),
    );
  });
  it('calculates acceptance with denominators and downgrade reasons', () => {
    const row: FindingDecision = {
      task: 'T',
      feature: null,
      execution: 'E',
      index: 0,
      role: 'reviewer',
      executor: 'codex',
      model: 'm',
      severity: 'minor',
      downgradeReasons: ['missing evidence'],
      decision: 'accept',
      actor: 'human',
      decidedAt: '',
    };
    expect(findingPrecision([row, { ...row, decision: 'reject', index: 1 }])).toEqual({
      groups: [
        {
          role: 'reviewer',
          executor: 'codex',
          model: 'm',
          severity: 'minor',
          n: 2,
          accepted: 1,
          acceptanceRate: 0.5,
        },
      ],
      downgraded: { 'missing evidence': 2 },
    });
  });
});
