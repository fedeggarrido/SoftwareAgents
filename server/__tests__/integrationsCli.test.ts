import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildSync } from 'esbuild';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { runFeatureCommand } from '../src/commands/feature.js';
import { EXECUTOR_PROBE_CATALOG } from '../src/executorProbes.js';
import { HumanDecisions } from '../src/humanDecisions.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import { developerVerifierConfig } from './helpers/developerVerifierConfig.js';
import { operatorToken } from './helpers/operatorToken.js';
import { readyProbeFor } from './helpers/readyProbe.js';
import { removeTempDir } from './helpers/removeTempDir.js';

vi.setConfig({ testTimeout: 90_000 });
vi.mock('../src/techLeadRuntime.js', () => ({ ensureProjectStack: vi.fn() }));
vi.mock('../src/projectStack.js', async (original) => ({
  ...(await original<typeof import('../src/projectStack.js')>()),
  requireProjectStack: () => 'fixture stack',
}));
vi.mock('../src/architecturePolicy.js', async (original) => ({
  ...(await original<typeof import('../src/architecturePolicy.js')>()),
  prepareArchitectureWorktree: () => {},
}));
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));
beforeAll(() =>
  buildSync({
    entryPoints: [path.resolve(__dirname, '../src/executors/containmentHook.ts')],
    outfile: path.resolve(__dirname, '../../dist/hooks/containment-hook.js'),
    bundle: true,
    platform: 'node',
    target: 'node20',
  }),
);

let root: string;
let repo: string;
let launches: string;
const key = 'FEAT-001-T01';
const storeFor = () => openWorkStore({ repositoryPath: repo, projectId: 'test' });
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'pipe',
  }).trim();
const run = (command: string[], fixture: string, executor: 'claude' | 'codex', mode = 'valid') =>
  runFeatureCommand(command, repo, () => {}, {
    binaryArgs: [
      path.join(__dirname, `fixtures/fake-${fixture}-cli.cjs`),
      executor,
      mode,
      launches,
    ],
    probe: readyProbeFor(EXECUTOR_PROBE_CATALOG),
  });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-integrations-cli-'));
  repo = path.join(root, 'repo');
  launches = path.join(root, 'launches.jsonl');
  fs.mkdirSync(path.join(repo, '.softwareagents/agents'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.softwareagents/brain'), { recursive: true });
  fs.mkdirSync(path.join(root, '.pixel-agents'));
  for (const name of ['HOME', 'USERPROFILE']) vi.stubEnv(name, root);
  operatorToken(root);
  vi.stubEnv('CODEX_HOME', path.join(root, 'codex'));
  vi.stubEnv('SA_TEST_NO_RATE_LIMIT', '1');
  for (const name of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(name, undefined);
  for (const role of ['AUTHOR', 'COMMITTER']) {
    vi.stubEnv(`GIT_${role}_NAME`, 'Test');
    vi.stubEnv(`GIT_${role}_EMAIL`, 'test@example.invalid');
  }
  git('init', '-b', 'main');
  developerVerifierConfig(repo);
  fs.writeFileSync(
    path.join(repo, '.softwareagents/project.yaml'),
    'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: test\nname: Test\nrepo:\n  remote: https://example.invalid/test.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n',
  );
  fs.writeFileSync(
    path.join(repo, '.softwareagents/agents/model-policy.yaml'),
    'high_reasoning:\n  - executor: claude\n  - executor: codex\nstandard_coding:\n  - executor: claude\n  - executor: codex\n',
  );
  fs.writeFileSync(path.join(repo, 'request.md'), 'Consultar pagos');
  fs.writeFileSync(
    path.join(repo, 'tsconfig.json'),
    '{"compilerOptions":{"noEmit":true},"include":["server/src/**/*.ts"]}',
  );
  git('add', '.');
  git('commit', '-m', 'fixture');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
  await removeTempDir(root);
});

it.skipIf(process.platform !== 'win32').each(['claude', 'codex'] as const)(
  'gates new access before %s execution and reuses developer verification after approval',
  async (executor) => {
    fs.writeFileSync(
      path.join(root, '.pixel-agents/config.json'),
      JSON.stringify({
        projects: {
          test: {
            autonomyLevel: 'A1',
            allowedExecutors: [executor],
            binaryPaths: { [executor]: process.execPath },
            quotaThresholds: { [executor]: 0 },
            concurrency: { maxExecutions: 1, perExecutor: { [executor]: 1 } },
          },
        },
      }),
    );
    await run(['spec', 'FEAT-001', '--request', 'request.md'], 'requirements', executor);
    await runFeatureCommand(['approve', 'FEAT-001'], repo, () => {});
    await run(['design', 'FEAT-001'], 'architect', executor, 'integrations');
    fs.writeFileSync(launches, '');
    await run(['develop', 'FEAT-001', '--task', key], 'developer', executor, 'integrations');
    expect(fs.readFileSync(launches, 'utf8')).toBe('');
    const store = await storeFor();
    try {
      expect(store.getTask(key)).toMatchObject({ status: 'WAITING_HUMAN', lease_owner: null });
      expect(store.listExecutions().filter((execution) => execution.task_key === key)).toEqual([]);
      await new HumanDecisions(store).answer(
        store.listDecisions().find((decision) => decision.requestedBy === 'integrations')!.id,
        'allow',
        true,
        'fede',
        'A1',
      );
    } finally {
      store.close();
    }
    process.exitCode = 0;
    await run(['develop', 'FEAT-001', '--task', key], 'developer', executor, 'integrations');
    const completed = await storeFor();
    try {
      expect(completed.getTask(key)).toMatchObject({
        status: 'REVIEW',
        agent_role: 'integrations',
      });
      expect(completed.listExecutions().filter((execution) => execution.task_key === key)).toEqual([
        expect.objectContaining({
          agent_role: 'integrations',
          agent_template_version: '1.0.0',
        }),
      ]);
      expect(completed.getTask(key)?.review_ref?.branch).toBe(`sa/${key}-developer`);
    } finally {
      completed.close();
    }
    expect(
      fs.readFileSync(
        path.join(repo, `.worktrees/${key}/.softwareagents/brain/integrations.yaml`),
        'utf8',
      ),
    ).toContain('service: payments');
  },
);
