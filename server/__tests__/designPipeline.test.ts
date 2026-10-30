import { describe, expect, it, vi } from 'vitest';

import { DESIGN_RUBRIC, type DesignReport } from '../../core/src/designReport.js';
import type { ProjectConfig } from '../../core/src/project.js';
import { runDesignGate } from '../src/designPipeline.js';
import { needsDesignReview, validateDesignRound } from '../src/designReviewLoop.js';
import type { FeatureRunState, TaskRecord, WorkStore } from '../src/workstore/WorkStore.js';

function fixture() {
  const config = { operator: { orchestrator: { designMaxRounds: 3 } } } as ProjectConfig;
  const state: FeatureRunState = {
    branch: 'integration',
    initial_main: 'base',
    head: 'head',
    request: '',
    integrated: {},
    status: 'running',
  };
  const task = {
    key: 'FEAT-105-T01',
    version: 1,
    status: 'QA',
    review_ref: { sha: 'first', base: 'base', branch: 'developer' },
    worktree_ref: 'task-tree',
    declaration: JSON.stringify({ changeZones: ['webview-ui/src/'] }),
  } as TaskRecord;
  const store = {
    openOrJoinIdleDecision: vi.fn(),
    requestDesignRework: vi.fn(),
  } as unknown as WorkStore;
  const save = vi.fn(async () => {});
  const finding: DesignReport['findings'][number] = {
    id: 'focus',
    severity: 'major',
    screen: 'features',
    area: 'button',
    problem: 'Invisible focus',
    principle: 'WCAG',
    fix: 'Visible outline',
  };
  const report: DesignReport = {
    verdict: 'request_changes',
    findings: [finding],
    validations: [],
    rubric: Object.fromEntries(DESIGN_RUBRIC.map((k) => [k, 4])) as DesignReport['rubric'],
  };
  const command: Parameters<typeof runDesignGate>[5] = vi.fn(async (_args, _cwd, log, options) => {
    await options!.pipeline!.onUsage(100);
    log!(JSON.stringify({ report, evidenceDirectory: `capture-${task.review_ref!.sha}` }));
  });
  return { config, state, task, store, save, report, command };
}
describe('pipeline design gate', () => {
  it('routes UI or explicit DAG flag; skips non UI without executions', async () => {
    expect(needsDesignReview({ needsDesignReview: true })).toBe(true);
    const f = fixture();
    f.task.declaration = JSON.stringify({ changeZones: ['server/src/'] });
    expect(await runDesignGate(f.store, f.config, f.state, f.task, f.save, f.command)).toBe(true);
    expect(f.command).not.toHaveBeenCalled();
  });
  it('reworks with durable history and escalates after three rounds with captures', async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) {
      f.task.review_ref!.sha = `sha-${i}`;
      expect(await runDesignGate(f.store, f.config, f.state, f.task, f.save, f.command)).toBe(
        false,
      );
    }
    expect(f.store.requestDesignRework).toHaveBeenCalledTimes(2);
    expect(f.store.openOrJoinIdleDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [f.task.key],
        context: expect.stringContaining('capture-sha-0'),
      }),
    );
    await runDesignGate(f.store, f.config, f.state, f.task, f.save, f.command);
    expect(f.command).toHaveBeenCalledTimes(3);
    expect(f.state.designReviews![f.task.key].tokens).toBe(300);
  });
  it('pins approval to the reviewed SHA and rechecks changed revisions', async () => {
    const f = fixture();
    f.report.verdict = 'approve';
    f.report.findings = [];
    expect(await runDesignGate(f.store, f.config, f.state, f.task, f.save, f.command)).toBe(true);
    expect(await runDesignGate(f.store, f.config, f.state, f.task, f.save, f.command)).toBe(true);
    expect(f.command).toHaveBeenCalledTimes(1);
    f.task.review_ref!.sha = 'changed';
    await runDesignGate(f.store, f.config, f.state, f.task, f.save, f.command);
    expect(f.command).toHaveBeenCalledTimes(2);
  });
  it('does not execute past cost or interrupted attempt gates', async () => {
    const f = fixture();
    f.config.operator.orchestrator!.designMaxTokens = 50;
    await runDesignGate(f.store, f.config, f.state, f.task, f.save, f.command);
    expect(f.store.openOrJoinIdleDecision).toHaveBeenCalled();
    await runDesignGate(f.store, f.config, f.state, f.task, f.save, f.command);
    expect(f.command).toHaveBeenCalledTimes(1);
  });
  it('retains the latest captures when cost exhaustion interrupts the report', async () => {
    const f = fixture();
    const command: Parameters<typeof runDesignGate>[5] = async (_args, _cwd, _log, options) => {
      await options!.pipeline!.onEvidence!('latest-captures');
      await options!.pipeline!.onUsage(100_000);
      throw new Error('Design token cost limit exhausted');
    };
    expect(await runDesignGate(f.store, f.config, f.state, f.task, f.save, command)).toBe(false);
    expect(f.store.openOrJoinIdleDecision).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.stringContaining('latest-captures') }),
    );
    expect(f.state.designReviews![f.task.key].pending).toBe(true);
  });
  it('requires rationale for new majors and justified regression for minor escalation', () => {
    const f = fixture();
    const previous = [{ ...f.report.findings[0], severity: 'minor' as const }];
    expect(() => validateDesignRound(f.report, previous)).toThrow(/regression/);
    f.report.findings[0].regression = true;
    f.report.findings[0].majorJustification = 'Outline removed in new SHA';
    expect(() => validateDesignRound(f.report, previous)).not.toThrow();
    f.report.findings[0].id = 'new';
    f.report.findings[0].problem = 'Different issue';
    f.report.findings[0].regression = false;
    delete f.report.findings[0].majorJustification;
    expect(() => validateDesignRound(f.report, previous)).toThrow(/justification/);
  });
});
