import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

import { execFileSync } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ProjectConfig } from '../../core/src/project.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { BoardWatcher } from '../src/boardWatcher.js';
import { runTaskCommand } from '../src/commands/task.js';
import { loadProjectConfig } from '../src/projectConfig.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import type { WorkStore } from '../src/workstore/WorkStore.js';
import { WorkStoreBoardSource } from '../src/workStoreBoardSource.js';

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: () => process.env.HOME ?? actual.homedir() };
});
vi.mock('child_process', async (original) => {
  const actual = await original<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((file, args, options) => {
      // task import only needs a recorded SHA; no commits or global Git config.
      if (file === 'git' && JSON.stringify(args) === JSON.stringify(['rev-parse', 'HEAD']))
        return 'a'.repeat(40);
      return actual.execFileSync(file, args, options);
    }),
  };
});
vi.mock('../src/projectConfig.js', () => ({ loadProjectConfig: vi.fn() }));
vi.mock('../src/companyControl.js', () => ({ readAutopilot: () => undefined }));
vi.mock('../src/quotaReader.js', () => ({
  claudeQuota: () => undefined,
  codexQuota: () => undefined,
}));

let root: string;
let repo: string;
let file: string;
let config: ProjectConfig;
let work: WorkStore | undefined;
let store: AgentStateStore;
let watcher: BoardWatcher;
const sources: WorkStoreBoardSource[] = [];
const first = 'FEAT-001-T01';
const second = 'FEAT-001-T02';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'workstore-board-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'no-git-config'));
  execFileSync('git', ['init', repo], { stdio: 'pipe', windowsHide: true });
  file = path.join(repo, '.git/softwareagents/work.sqlite3');
  fs.mkdirSync(path.join(repo, 'brain/features/requests'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs/backlog'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'docs/backlog/board.json'),
    JSON.stringify({
      items: [{ id: 'OLD', title: 'Legacy', phase: 'READY' }],
    }),
  );
  config = {
    repoRoot: repo,
    paths: { brain: path.join(repo, 'brain') },
    project: {
      apiVersion: 'softwareagents.io/v1alpha1',
      kind: 'Project',
      id: 'fixture',
      name: 'Fixture',
      repo: { remote: 'https://example.invalid/fixture.git', defaultBranch: 'main' },
      brain: { path: 'brain' },
      legacy: { boardFile: 'docs/backlog/board.json' },
    },
    operator: { autonomyLevel: 'A0', allowedExecutors: [] },
  };
  vi.mocked(loadProjectConfig).mockReturnValue(config);
  store = new AgentStateStore();
  watcher = new BoardWatcher(store, repo, Date.now, { kind: 'project', project: config });
});
afterEach(() => {
  watcher.dispose();
  for (const source of sources.splice(0)) source.dispose();
  work?.close();
  work = undefined;
  store.dispose();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

async function imported(): Promise<WorkStore> {
  fs.writeFileSync(
    path.join(repo, 'brain/features/requests/FEAT-001.yaml'),
    JSON.stringify({
      apiVersion: 'softwareagents.io/v1alpha1',
      kind: 'FeatureSpec',
      key: 'FEAT-001',
      version: '1.0.0',
      status: 'approved',
      title: 'Fixture',
      goal: 'Board',
      userValue: 'Tasks',
      actors: [],
      flows: [],
      rules: [],
      edgeCases: [],
      openQuestions: [],
      links: { adr: [], clickup: [] },
      acceptance: [{ id: 'AC-001', given: 'a DAG', when: 'import', then: 'tasks appear' }],
    }),
  );
  fs.writeFileSync(
    path.join(repo, 'dag.yaml'),
    JSON.stringify({
      apiVersion: 'softwareagents.io/v1alpha1',
      kind: 'TaskDAG',
      feature: 'FEAT-001',
      tasks: [first, second].map((key, i) => ({
        key,
        type: 'code',
        title: key,
        description: 'private prompt',
        acceptanceRefs: ['AC-001'],
        dependsOn: i ? [first] : [],
        agentRole: 'developer',
        size: 'M',
      })),
    }),
  );
  await runTaskCommand(['import', 'dag.yaml'], repo, () => {});
  work = await openWorkStore({ repositoryPath: repo, projectId: 'fixture' });
  return work;
}

async function poll(): Promise<void> {
  // start resolves the common Git directory; overlapping reads are coalesced.
  watcher.start();
  await watcher.tick();
}

it('shows task import rows with their exact states, keys and dependencies instead of legacy', async () => {
  await imported();
  await poll();
  const board = watcher.build()!;
  expect(board.sources).toEqual({ board: true, workStore: true, claims: false, progress: false });
  expect(board.items.map((t) => [t.id, t.phase])).toEqual([
    [first, 'DRAFT'],
    [second, 'DRAFT'],
  ]);
  expect(board.items[1].dependsOn).toEqual([first]);
  expect(board.items[0].owner?.worker).toBe('developer');
  expect(JSON.stringify(board)).not.toContain('private prompt');
});

it('refreshes phase, lease holder and last domain event without writing or sweeping expired leases', async () => {
  const work = await imported();
  await work.transition(first, 1, 'READY', 'private reason', 'private actor');
  await work.claim(first, 'fixture-worker');
  await poll();
  expect(watcher.build()?.items[0]).toMatchObject({
    id: first,
    phase: 'LEASED',
    owner: { worker: 'fixture-worker', state: 'active', stale: false },
    lastEvent: {
      task: first,
      session: first,
      phase: 'LEASED',
      state: '',
      detail: 'QUEUED → LEASED',
    },
  });
  await work.transition(first, work.getTask(first)!.version, 'RUNNING', 'secret', 'actor');
  const before = work.getTask(first);
  const last = work.listDomainEvents(first).at(-1)!;
  await watcher.tick();
  expect(watcher.build()?.items[0].phase).toBe('RUNNING');
  expect(watcher.build()?.items[0].lastEvent?.detail).toBe('LEASED → RUNNING');
  expect(watcher.build()?.items[0].lastEvent?.at).toBe(Date.parse(last.created_at));
  const source = new WorkStoreBoardSource();
  sources.push(source);
  const future = await source.read(file, 'fixture', Date.now() + 86_400_000);
  expect(future?.items[0].owner?.stale).toBe(true);
  expect(work.getTask(first)).toEqual(before);
  expect(JSON.stringify(watcher.build())).not.toContain('secret');
});

it('uses the recorded execution role/session when there is no lease and excludes feature documents', async () => {
  const work = await imported();
  for (const key of ['FEAT-001', 'FEAT-001-DESIGN', 'FEAT-001-REQUIREMENTS'])
    work.createTask({ key, type: 'doc', status: 'REVIEW' });
  // Fixture-only SQL: no production writer is used by the board reader.
  const db = new DatabaseSync(file);
  db.prepare(
    `INSERT INTO executions (project_id, key, task_key, agent_template_version, executor,
    model_id, session_id, started_at, system_prompt_hash, project_brain_sha, task_version,
    tool_policy_version, agent_role) VALUES (?, ?, ?, '', 'fixture', '', ?, ?, '', '', 1, '', 'reviewer')`,
  ).run('fixture', 'execution-1', first, 'session-1', new Date().toISOString());
  db.close();
  await poll();
  expect(watcher.build()?.items.map((t) => t.id)).toEqual([first, second]);
  expect(watcher.build()?.items[0].owner).toMatchObject({
    worker: 'reviewer',
    session: 'session-1',
    state: 'DRAFT',
  });
});

it('uses legacy when the Project has no WorkStore', async () => {
  await poll();
  expect(watcher.build()?.items[0].id).toBe('OLD');
  expect(watcher.build()?.sources.workStore).toBeUndefined();
  expect(fs.existsSync(file)).toBe(false);
});

it('uses legacy when an existing WorkStore only registers another Project', async () => {
  work = await openWorkStore({ repositoryPath: repo, projectId: 'other' });
  await poll();
  expect(watcher.build()?.items[0].id).toBe('OLD');
  expect(watcher.build()?.sources.workStore).toBeUndefined();
});

it('does not fall back to stale legacy data when an existing WorkStore is unreadable', async () => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'corrupt');
  await poll();
  expect(watcher.build()).toMatchObject({ items: [], sources: { board: false, workStore: true } });
});

it('keeps a legacy selection on its legacy board even if a WorkStore exists', async () => {
  await imported();
  watcher.dispose();
  watcher = new BoardWatcher(store, repo, Date.now, { kind: 'legacy' });
  await poll();
  expect(watcher.build()?.items[0].id).toBe('OLD');
});

it('reads a minified standalone bundle and leaves database bytes unchanged', async () => {
  await imported();
  work!.close();
  work = undefined;
  const before = fs.readFileSync(file);
  const bundle = path.join(root, 'source.cjs');
  buildSync({
    entryPoints: [path.join(__dirname, '../src/workStoreBoardSource.ts')],
    outfile: bundle,
    bundle: true,
    minify: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const { WorkStoreBoardSource: BundledSource } = createRequire(bundle)(bundle) as {
    WorkStoreBoardSource: typeof WorkStoreBoardSource;
  };
  const source = new BundledSource();
  sources.push(source);
  expect((await source.read(file, 'fixture', Date.now()))?.items.map((t) => t.id)).toEqual([
    first,
    second,
  ]);
  expect(fs.readFileSync(file)).toEqual(before);
});

it('keeps a registered empty WorkStore empty instead of falling back to legacy', async () => {
  work = await openWorkStore({ repositoryPath: repo, projectId: 'fixture' });
  await poll();
  expect(watcher.build()).toMatchObject({ items: [], sources: { board: true, workStore: true } });
});

it('sends only pending decisions with allow-listed fields, never answers or actors', async () => {
  const store = await imported();
  await store.openDecision({
    id: 'decision',
    context: 'Choose a strategy',
    options: [
      { id: 'review', label: 'Review', benefit: 'Confidence', cost: 'Time', risk: 'Delay' },
    ],
    recommendation: 'Review',
    disagreement: [{ role: 'developer', position: 'private disagreement' }],
    impact: 'Blocks work',
    urgency: 'high',
    requestedBy: 'developer',
    blocks: [first],
  });
  await poll();
  const [pending] = watcher.build()!.decisions!;
  expect(Object.keys(pending).sort()).toEqual(
    [
      'blocks',
      'id',
      'impact',
      'options',
      'question',
      'recommendation',
      'requestedBy',
      'status',
      'structuredOptions',
      'urgency',
    ].sort(),
  );
  expect(JSON.stringify(pending)).not.toContain('private disagreement');
  const db = new DatabaseSync(file);
  try {
    const row = db.prepare('SELECT escalation FROM human_decisions').get() as {
      escalation: string;
    };
    const answered = {
      ...JSON.parse(row.escalation),
      status: 'answered',
      answer: 'secret answer',
      answeredBy: 'fede',
    };
    db.prepare('UPDATE human_decisions SET escalation = ?').run(JSON.stringify(answered));
  } finally {
    db.close();
  }
  await poll();
  expect(watcher.build()!.decisions ?? []).toEqual([]);
  expect(JSON.stringify(watcher.build())).not.toContain('secret answer');
});
