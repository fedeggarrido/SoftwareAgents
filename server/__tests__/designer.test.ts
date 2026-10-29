import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { PRODUCT_DESIGNER_SPEC } from '../../core/src/agentSpec.js';
import {
  DESIGN_RUBRIC,
  type DesignReport,
  type DesignValidation,
} from '../../core/src/designReport.js';
import type { ProjectConfig } from '../../core/src/project.js';
import { compileAgent, executorSupportsRole } from '../src/agentCompiler.js';
import { roleFromBrief } from '../src/agentRoles.js';
import { runDesignCommand } from '../src/commands/design.js';
import { contrastRatio, validateDesignReport } from '../src/designer.js';
import type { Executor } from '../src/executors/executor.js';

const validations: DesignValidation[] = [
  { kind: 'capture', tool: 'playwright/v1', result: 'pass', evidence: 'office.png' },
  {
    kind: 'contrast',
    tool: 'playwright-wcag/v1',
    result: 'pass',
    evidence: 'office-contrast.json',
  },
];
const report = (): DesignReport => ({
  verdict: 'approve',
  findings: [],
  rubric: Object.fromEntries(DESIGN_RUBRIC.map((k) => [k, 4])) as DesignReport['rubric'],
  validations,
});
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Designer phase 1', () => {
  it('calculates WCAG known pairs symmetrically', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBe(21);
    expect(contrastRatio([119, 119, 119], [255, 255, 255])).toBeCloseTo(4.478, 2);
    expect(contrastRatio([255, 255, 255], [119, 119, 119])).toBeCloseTo(4.478, 2);
    expect(contrastRatio([0, 0, 0], [0, 0, 0])).toBe(1);
    expect(() => contrastRatio([-1, 0, 0], [0, 0, 0])).toThrow();
  });
  it('validates schema, blocking findings and runtime evidence', () => {
    expect(validateDesignReport(JSON.stringify(report()), validations).verdict).toBe('approve');
    const blocked = report();
    blocked.findings.push({
      severity: 'blocker',
      screen: 'office',
      area: 'toolbar',
      problem: 'Unreadable',
      principle: 'WCAG',
      fix: 'Increase contrast',
    });
    expect(() => validateDesignReport(JSON.stringify(blocked), validations)).toThrow(
      /prohibits approve/,
    );
    blocked.verdict = 'request_changes';
    expect(validateDesignReport(JSON.stringify(blocked), validations)).toEqual(blocked);
    const invented = report();
    invented.validations = [
      { kind: 'contrast', tool: 'model', result: 'pass', evidence: 'Looks fine' },
    ];
    expect(() => validateDesignReport(JSON.stringify(invented), validations)).toThrow();
    expect(() => validateDesignReport(JSON.stringify(report()), [])).toThrow();
    const missing = report();
    missing.validations = validations.map((v) => ({ ...v, evidence: '' }));
    expect(() => validateDesignReport(JSON.stringify(missing), missing.validations)).toThrow();
    const failed = validations.map((v) => ({ ...v, result: 'fail' as const }));
    expect(() =>
      validateDesignReport(JSON.stringify({ ...report(), validations: failed }), failed),
    ).toThrow();
    expect(() =>
      validateDesignReport(JSON.stringify({ ...report(), rubric: { hierarchy: 6 } }), validations),
    ).toThrow();
  });
  it('compiles with only read tools and stable versioned instructions', () => {
    const compiled = compileAgent(PRODUCT_DESIGNER_SPEC, 'product-designer', { task: {} });
    expect(compiled.claude.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
    expect(compiled.systemPrompt).toContain('phase1/v1.0.0');
    expect(executorSupportsRole('codex', 'product-designer')).toBe(false);
    expect(
      parse(fs.readFileSync(path.resolve('../agents/templates/product-designer.yaml'), 'utf8')),
    ).toEqual(PRODUCT_DESIGNER_SPEC);
    expect(roleFromBrief('Role: product-designer', 'claude').label).toBe(
      'Principal Product Designer',
    );
  });
  it('command uses fake executor and persists validated report and audit', async () => {
    for (const key of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
      vi.stubEnv(key, undefined);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designer-command-'));
    dirs.push(root);
    const brain = path.join(root, 'brain');
    fs.mkdirSync(brain);
    const config = {
      project: { id: 'demo' },
      repoRoot: root,
      paths: { brain },
      operator: { allowedExecutors: ['claude'], autonomyLevel: 'A0' },
    } as ProjectConfig;
    const append = vi.fn(),
      log = vi.fn();
    const executor: Executor = {
      id: 'claude',
      start: vi.fn((req) => {
        expect(req.agentSpec?.permissions.profile).toBe('read_only');
        expect(req.taskData?.task).toMatchObject({ views: ['office'], images: ['office.png'] });
        return {
          cancel() {},
          events: (async function* () {
            yield {
              type: 'finished' as const,
              exitCode: 0,
              resultSummary: JSON.stringify(report()),
            };
          })(),
        };
      }),
    };
    await runDesignCommand(['review', '--views', 'office', '--json'], root, log, {
      config,
      executor,
      capture: async () => ({ images: ['office.png'], validations }),
      audit: { append },
      runtimeDirectory: path.join(root, 'runtime'),
    });
    const output = JSON.parse(log.mock.calls[0][0]);
    expect(
      JSON.parse(fs.readFileSync(path.join(output.evidenceDirectory, 'report.json'), 'utf8')),
    ).toEqual(report());
    expect(append.mock.calls.map((c) => c[0].outcome.status)).toEqual(['started', 'approve']);
  });
});
