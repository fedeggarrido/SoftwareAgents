/* eslint-disable pixel-agents/no-inline-colors -- Deliberate token/CSS fixtures; no product styling. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, expect, it, vi } from 'vitest';

import type { HumanDecision, NewHumanDecision } from '../../core/src/humanDecision.js';
import type { ProjectConfig } from '../../core/src/project.js';
import { compileAgent } from '../src/agentCompiler.js';
import { DIRECTION_WEIGHTS } from '../src/artDirection.js';
import { runDesignCommand } from '../src/commands/design.js';
import type { Executor } from '../src/executors/executor.js';
import type { WorkStore } from '../src/workstore/WorkStore.js';
import { operatorToken } from './helpers/operatorToken.js';

const git = vi.hoisted(() => vi.fn(() => 'sa/design-test'));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFileSync: git,
}));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  git.mockReset().mockReturnValue('sa/design-test');
});

it('re-explores once, drafts off main, opens HumanDecision, and applies only human-selected tokens', async () => {
  for (const key of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(key, undefined);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'direction-command-'));
  roots.push(root);
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  operatorToken(root);
  // Windows aliases this name to the capability set by the helper.
  vi.stubEnv('pixel_agents_operator_token', process.env.PIXEL_AGENTS_OPERATOR_TOKEN!);
  const brain = path.join(root, 'brain'),
    tree = path.join(root, 'proposal');
  fs.mkdirSync(brain);
  fs.mkdirSync(path.join(root, 'node_modules/prettier/bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/prettier/bin/prettier.cjs'), '');
  fs.mkdirSync(path.join(tree, 'webview-ui/src'), { recursive: true });
  fs.writeFileSync(
    path.join(tree, 'webview-ui/src/index.css'),
    ':root { --color-bg: #111111; --color-text: #eeeeee; }\nbutton { display: flex; }',
  );
  const config = {
    repoRoot: root,
    project: { id: 'demo', repo: { defaultBranch: 'main' } },
    paths: { brain },
    operator: { allowedExecutors: ['claude'] },
  } as ProjectConfig;
  let decision: HumanDecision | undefined;
  const store = {
    openDecision: vi.fn(
      async (d: NewHumanDecision) =>
        (decision = { ...d, status: 'open', answeredBy: null, answeredAt: null }),
    ),
    listDecisions: () => (decision ? [decision] : []),
  } as unknown as WorkStore;
  const proposal = {
    diagnosis: 'Work interface',
    recommendation: 'swiss',
    drawbacks: 'Restrained',
    directions: ['swiss', 'retro', 'editorial'].map((id) => ({
      id,
      name: id,
      style: id,
      influences: id,
      personality: id,
      composition: id,
      colorStrategy: id,
      typographyIconography: id,
      advantages: 'Clarity',
      limitations: 'Density',
      risks: 'Migration',
      fit: 'Professional',
      complexity: 'Medium',
      scores: Object.fromEntries(Object.keys(DIRECTION_WEIGHTS).map((k) => [k, 4])),
      total: 99,
    })),
  };
  let calls = 0;
  const executor: Executor = {
    id: 'claude',
    start: vi.fn((req) => {
      compileAgent(req.agentSpec!, req.role!, req.taskData!);
      return {
        cancel() {},
        events: (async function* () {
          calls++;
          const operation = (req.taskData!.task as { operation: string }).operation;
          const result =
            operation === 'apply-direction'
              ? {
                  colorSystem: 'Harmony, HEX + OKLCH, roles, scales and prohibited combinations',
                  designSystem: 'Typography, components and states',
                  tokens: [
                    { name: '--color-bg', value: '#000000' },
                    { name: '--color-text', value: '#ffffff' },
                  ],
                  approved: [
                    { foreground: '--color-text', background: '--color-bg', usage: 'normal' },
                  ],
                }
              : calls === 1
                ? {
                    ...proposal,
                    directions: proposal.directions.map((d) => ({
                      ...d,
                      style: 'same',
                      composition: 'same',
                    })),
                  }
                : proposal;
          yield { type: 'finished' as const, exitCode: 0, resultSummary: JSON.stringify(result) };
        })(),
      };
    }),
  };
  const options = {
    config,
    store,
    executor,
    audit: { append: vi.fn() },
    runtimeDirectory: path.join(root, 'runtime'),
    capture: async () => ({
      images: ['runtime.png'],
      validations: [
        {
          kind: 'capture' as const,
          tool: 'playwright/v1',
          result: 'pass' as const,
          evidence: 'runtime.png',
        },
      ],
    }),
    proposalTree: () => tree,
  };
  await runDesignCommand(['direction', '--json'], root, vi.fn(), options);
  expect(calls).toBe(2);
  const docs = ['visual-direction', 'color-system', 'design-system'].map(
    (name) => `docs/design/${name}.md`,
  );
  expect(git).toHaveBeenCalledWith(
    process.execPath,
    [path.join(root, 'node_modules/prettier/bin/prettier.cjs'), '--write', ...docs],
    expect.objectContaining({ cwd: tree }),
  );
  expect(git).toHaveBeenCalledWith(
    'git',
    ['add', '--', ...docs],
    expect.objectContaining({ cwd: tree }),
  );
  expect(git).toHaveBeenCalledWith(
    'git',
    expect.arrayContaining([
      'commit',
      '--only',
      `docs(SA-105): draft art direction decision ${decision!.id}`,
      '--',
      ...docs,
    ]),
    expect.objectContaining({
      cwd: tree,
      env: expect.objectContaining({
        GIT_AUTHOR_NAME: 'SoftwareAgents Runtime',
        GIT_COMMITTER_NAME: 'SoftwareAgents Runtime',
      }),
    }),
  );
  expect(decision!.options).toHaveLength(3);
  expect(decision!.context).toContain('Dirección artística');
  expect(fs.existsSync(path.join(root, 'docs'))).toBe(false);
  expect(fs.readFileSync(path.join(tree, 'docs/design/visual-direction.md'), 'utf8')).not.toContain(
    '99',
  );
  await expect(
    runDesignCommand(['apply-direction', '--decision', decision!.id], root, vi.fn(), options),
  ).rejects.toThrow(/Answered human/);
  decision!.status = 'answered';
  decision!.answer = 'retro';
  decision!.answeredBy = 'operator';
  await runDesignCommand(['apply-direction', '--decision', decision!.id], root, vi.fn(), options);
  expect(git).toHaveBeenCalledWith(
    'git',
    expect.arrayContaining([
      'commit',
      '--only',
      `docs(SA-105): apply art direction decision ${decision!.id}`,
      '--',
      ...docs,
      'webview-ui/src/index.css',
    ]),
    expect.objectContaining({ cwd: tree }),
  );
  expect(fs.readFileSync(path.join(tree, 'docs/design/color-system.md'), 'utf8')).toContain(
    '21.000:1',
  );
  expect(fs.readFileSync(path.join(tree, 'webview-ui/src/index.css'), 'utf8')).toContain(
    'button { display: flex; }',
  );
  // Includes checkout, branch lookup, formatting and proposal publication.
  for (const call of git.mock.calls as unknown as [
    string,
    string[],
    { env: NodeJS.ProcessEnv },
  ][]) {
    expect(call[2].env).toBeDefined();
    expect(
      Object.keys(call[2].env).some((key) => key.toUpperCase() === 'PIXEL_AGENTS_OPERATOR_TOKEN'),
    ).toBe(false);
  }
  git.mockReturnValue('main');
  git.mockClear();
  await expect(runDesignCommand(['direction'], root, vi.fn(), options)).rejects.toThrow(
    /proposal branch/,
  );
  expect(
    git.mock.calls.some(
      (call) =>
        (call as unknown[])[1] instanceof Array &&
        ((call as unknown[])[1] as string[]).includes('commit'),
    ),
  ).toBe(false);
});
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));
