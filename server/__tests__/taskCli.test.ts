import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { AuditLog } from '../src/auditLog.js';
import { runTaskCommand } from '../src/commands/task.js';
import { TASK_CLI_INPUT_BYTES } from '../src/constants.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import type { WorkStore } from '../src/workstore/WorkStore.js';

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: () => process.env.HOME ?? actual.homedir() };
});

let bundleRoot: string;
let bundle: string;
let root: string;
let repo: string;
const stores: WorkStore[] = [];
const first = 'FEAT-001-T01';
const second = 'FEAT-001-T02';
const dag = () => ({
  apiVersion: 'softwareagents.io/v1alpha1',
  kind: 'TaskDAG',
  feature: 'FEAT-001',
  tasks: [first, second].map((key, i) => ({
    key,
    type: 'code',
    title: key,
    description: 'Implement',
    acceptanceRefs: ['AC-001'],
    dependsOn: i ? [first] : [],
    agentRole: 'developer',
    size: 'M',
  })),
});

beforeAll(() => {
  bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cli-bundle-'));
  bundle = path.join(bundleRoot, 'cli.cjs');
  buildSync({
    entryPoints: [path.join(__dirname, '../src/cli.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['node:sqlite'],
    logLevel: 'silent',
  });
});
afterAll(() => fs.rmSync(bundleRoot, { recursive: true, force: true }));
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cli-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'no-git-config'));
  for (const who of ['AUTHOR', 'COMMITTER']) {
    vi.stubEnv(`GIT_${who}_NAME`, 'Test');
    vi.stubEnv(`GIT_${who}_EMAIL`, 'test@example.invalid');
  }
  git('init', '-b', 'main');
  fs.mkdirSync(path.join(repo, '.softwareagents/brain/features/requests'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.softwareagents/project.yaml'),
    'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: test\nname: Test\nrepo:\n  remote: https://example.invalid/test.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n',
  );
  fs.writeFileSync(
    path.join(repo, '.softwareagents/brain/features/requests/FEAT-001.yaml'),
    JSON.stringify({
      apiVersion: 'softwareagents.io/v1alpha1',
      kind: 'FeatureSpec',
      key: 'FEAT-001',
      version: '1.0.0',
      status: 'approved',
      title: 'CLI',
      goal: 'Import',
      userValue: 'Tasks',
      actors: [],
      flows: [],
      rules: [],
      edgeCases: [],
      openQuestions: [],
      links: { adr: [], clickup: [] },
      acceptance: [{ id: 'AC-001', given: 'a DAG', when: 'import', then: 'tasks exist' }],
    }),
  );
  writeDag(dag());
  git('add', '.');
  git('commit', '-m', 'fixture');
});
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
function git(...args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
}
function writeDag(value: unknown) {
  fs.writeFileSync(path.join(repo, 'dag.yaml'), JSON.stringify(value));
}
function cli(...args: string[]) {
  const result = spawnSync(process.execPath, [bundle, 'task', ...args], {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    env: { ...process.env, HOME: root, USERPROFILE: root, NODE_NO_WARNINGS: '1' },
  });
  if (result.error) throw result.error;
  return { code: result.status, out: result.stdout, err: result.stderr };
}
async function open() {
  const store = await openWorkStore({ repositoryPath: repo, projectId: 'test' });
  stores.push(store);
  return store;
}
function dbFile() {
  return path.join(repo, '.git/softwareagents/work.sqlite3');
}

it('dispatches import/list, reimports without duplication and preserves a live lease', async () => {
  expect(cli('import', 'dag.yaml')).toMatchObject({ code: 0, err: '' });
  const store = await open();
  await store.transition(first, 1, 'READY', 'ready', 'operator');
  await store.claim(first, 'test-worker');
  const before = store.getTask(first);
  expect(cli('import', 'dag.yaml').out).toContain('0 created, 2 unchanged');
  expect(store.getTask(first)).toEqual(before);
  expect(store.listTasks()).toHaveLength(2);
  expect(store.listTaskDependencies(second)).toHaveLength(1);
  const rows = JSON.parse(cli('list', '--json').out);
  expect(rows[0]).toMatchObject({
    lease_owner: 'test-worker',
    lease_expires_at: expect.any(String),
  });
  expect(rows[1].blockingReasons).toEqual([`Dependencies pending: ${first}`]);
  expect(cli('list', '--status', 'LEASED').out).toContain('owner=test-worker');
  expect(JSON.parse(cli('list', '--status', 'DONE', '--json').out)).toEqual([]);
  expect(
    new AuditLog()
      .read('test')
      .filter((row) => !row.corrupt && row.entry.outcome.status === 'committed'),
  ).toHaveLength(2);
});

it('rejects changed declarations atomically, including changes to declarative-only fields', async () => {
  expect(cli('import', 'dag.yaml').code).toBe(0);
  const changed = dag();
  changed.tasks.unshift({ ...changed.tasks[0], key: 'FEAT-001-T03' });
  changed.tasks[1].title = 'Changed';
  writeDag(changed);
  expect(cli('import', 'dag.yaml')).toMatchObject({
    code: 1,
    err: expect.stringContaining('immutable declaration'),
  });
  const store = await open();
  expect(store.listTasks()).toHaveLength(2);
  expect(store.getTask('FEAT-001-T03')).toBeUndefined();
});

it('imports and reimports with an additive tasks/dependencies column', async () => {
  await open();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbFile());
  try {
    db.exec(
      'ALTER TABLE tasks ADD COLUMN future TEXT; ALTER TABLE task_dependencies ADD COLUMN future TEXT;',
    );
    expect(cli('import', 'dag.yaml')).toMatchObject({ code: 0, err: '' });
    expect(cli('import', 'dag.yaml').out).toContain('0 created, 2 unchanged');
    expect(db.prepare('SELECT declaration, future FROM tasks WHERE key = ?').get(first)).toEqual({
      declaration: expect.any(String),
      future: null,
    });
    expect(db.prepare('SELECT future FROM task_dependencies').all()).toEqual([{ future: null }]);
  } finally {
    db.close();
  }
});

it('escapes terminal controls in text fields while preserving original JSON values', async () => {
  expect(cli('import', 'dag.yaml').code).toBe(0);
  const store = await open();
  const controls = '\n\r\t\x1b[2J\x01\x1f\x7f\x85\x9f';
  const escaped = '\\n\\r\\t\\u001b[2J\\u0001\\u001f\\u007f\\u0085\\u009f';
  const key = `extra${controls}`;
  const reason = `blocked${controls}`;
  const owner = `worker${controls}`;
  store.createTask({ key, type: 'doc', blocked_reason: reason });
  await store.transition(first, 1, 'READY', 'ready', 'operator');
  await store.claim(first, owner);
  const text = cli('list');
  expect(text).toMatchObject({ code: 0, err: '' });
  const lines = text.out.trimEnd().split(/\r?\n/);
  expect(lines).toHaveLength(3);
  for (const line of lines) expect(line.split('\t')).toHaveLength(5);
  expect(text.out).toContain(`extra${escaped}`);
  expect(text.out).toContain(`blocked${escaped}`);
  expect(text.out).toContain(`owner=worker${escaped}`);
  expect(JSON.parse(cli('list', '--json').out)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key, blocked_reason: reason, blockingReasons: [reason] }),
      expect.objectContaining({ key: first, lease_owner: owner }),
    ]),
  );
});

it('escapes controls in import error diagnostics', () => {
  const result = cli('import', 'missing\n\r\x1b.yaml');
  expect(result.code).toBe(1);
  expect(result.err.trimEnd().split(/\r?\n/)).toHaveLength(1);
  expect(result.err).not.toContain('\x1b');
});

it('rejects a declared Brain junction targeting another directory inside the checkout', () => {
  const link = path.join(repo, '.softwareagents/linked-brain');
  const target = path.join(repo, '.softwareagents/brain');
  const spec = path.join(target, 'features/requests/FEAT-001.yaml');
  const original = fs.readFileSync(spec, 'utf8');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const config = path.join(repo, '.softwareagents/project.yaml');
    fs.writeFileSync(
      config,
      fs
        .readFileSync(config, 'utf8')
        .replace('path: .softwareagents/brain', 'path: .softwareagents/linked-brain'),
    );
    expect(cli('import', 'dag.yaml')).toMatchObject({
      code: 1,
      err: expect.stringContaining('Links are forbidden'),
    });
    expect(fs.existsSync(dbFile())).toBe(false);
    expect(fs.readFileSync(spec, 'utf8')).toBe(original);
  } finally {
    fs.unlinkSync(link);
  }
});

it.each(['schema', 'cycle', 'dangling', 'duplicate', 'coverage', 'yaml', 'large'])(
  'invalid %s input exits nonzero, without stack or partial DB activation',
  (kind) => {
    const value = dag();
    if (kind === 'schema') value.tasks[0].type = 'bad';
    if (kind === 'cycle') value.tasks[0].dependsOn = [second];
    if (kind === 'dangling') value.tasks[0].dependsOn = ['FEAT-001-T99'];
    if (kind === 'duplicate') value.tasks.push(value.tasks[0]);
    if (kind === 'coverage')
      value.tasks.forEach((task) => {
        task.acceptanceRefs = [];
      });
    writeDag(value);
    if (kind === 'yaml') fs.writeFileSync(path.join(repo, 'dag.yaml'), 'kind: [');
    if (kind === 'large')
      fs.writeFileSync(path.join(repo, 'dag.yaml'), 'x'.repeat(TASK_CLI_INPUT_BYTES + 1));
    const result = cli('import', 'dag.yaml');
    expect(result.code).toBe(1);
    expect(result.err).toContain('task import:');
    expect(result.err).not.toMatch(/\n\s+at /);
    expect(fs.existsSync(dbFile())).toBe(false);
  },
);

it.each([
  [],
  ['import'],
  ['list', '--status', 'bad'],
  ['list', '--json', '--json'],
  ['backup', '--keep', '0'],
  ['backup', '--keep', '1.5'],
  ['backup', '--keep', '1001'],
  ['restore', 'x'],
])('rejects usage %j before opening WorkStore', (...args) => {
  const result = cli(...args);
  expect(result.code).toBe(1);
  expect(result.err).not.toMatch(/\n\s+at /);
  expect(fs.existsSync(dbFile())).toBe(false);
});

it('explains quota reset and open human decisions', async () => {
  expect(cli('import', 'dag.yaml').code).toBe(0);
  const store = await open();
  await store.transition(first, 1, 'READY', 'ready', 'operator');
  const reset = '2099-01-01T00:00:00.000Z';
  await store.transition(
    first,
    2,
    'WAITING_QUOTA',
    JSON.stringify({ reason: 'quota exhausted', resetsAt: reset }),
    'worker',
  );
  await store.openOrJoinIdleDecision({
    id: 'decision-1',
    context: 'Choose an executor',
    options: [{ id: 'wait', label: 'Wait', benefit: 'Safe', cost: 'Time', risk: 'Delay' }],
    recommendation: 'wait',
    disagreement: [],
    impact: 'Blocked',
    urgency: 'low',
    requestedBy: 'operator',
    blocks: [second],
  });
  const rows = JSON.parse(cli('list', '--json').out);
  expect(rows[0]).toMatchObject({
    resetsAt: reset,
    blockingReasons: expect.arrayContaining(['quota exhausted']),
  });
  expect(rows[1].blockingReasons.join(' ')).toContain('Choose an executor');
});

it('VACUUM backup includes committed WAL and offline restore recovers tasks, edges and audit', async () => {
  expect(cli('import', 'dag.yaml').code).toBe(0);
  const store = await open();
  const { DatabaseSync } = await import('node:sqlite');
  const connection = new DatabaseSync(dbFile());
  try {
    connection.exec('PRAGMA wal_autocheckpoint=0');
    store.createTask({ key: 'wal-only', type: 'doc' });
    expect(fs.statSync(`${dbFile()}-wal`).size).toBeGreaterThan(0);
    const originalAudit = fs.readFileSync(new AuditLog().file('test'), 'utf8');
    const result = cli('backup');
    expect(result).toMatchObject({ code: 0, err: '' });
    const backup = result.out.trim();
    const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'));
    expect(manifest.projectId).toBe('test');
    for (const file of ['work.sqlite3', 'audit.jsonl'])
      expect(
        createHash('sha256')
          .update(fs.readFileSync(path.join(backup, file)))
          .digest('hex'),
      ).toBe(manifest.hashes[file]);
    const snapshot = new DatabaseSync(path.join(backup, 'work.sqlite3'), { readOnly: true });
    try {
      expect(snapshot.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
      expect(snapshot.prepare('SELECT key FROM tasks WHERE key = ?').get('wal-only')).toBeDefined();
    } finally {
      snapshot.close();
    }
    connection.close();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    // The documented offline restore: all connections closed, move DB AND sidecars aside,
    // copy the snapshot plus Project audit, then reopen. No live-file replacement.
    fs.renameSync(path.dirname(dbFile()), path.join(repo, '.git/pre-restore'));
    fs.mkdirSync(path.dirname(dbFile()));
    fs.copyFileSync(path.join(backup, 'work.sqlite3'), dbFile(), fs.constants.COPYFILE_EXCL);
    const auditFile = new AuditLog().file('test');
    fs.renameSync(auditFile, `${auditFile}.before-restore`);
    fs.copyFileSync(path.join(backup, 'audit.jsonl'), auditFile, fs.constants.COPYFILE_EXCL);
    const restored = await open();
    expect(restored.listTasks()).toHaveLength(3);
    expect(restored.listTaskDependencies(second)).toHaveLength(1);
    expect(fs.readFileSync(auditFile, 'utf8')).toBe(originalAudit);
    expect(cli('import', 'dag.yaml').out).toContain('0 created, 2 unchanged');
    expect(cli('list', '--json').code).toBe(0);
  } finally {
    try {
      connection.close();
    } catch {
      /* Already closed before restore. */
    }
  }
});

it('rotates to N complete copies and fails safely on an audit lock', () => {
  expect(cli('import', 'dag.yaml').code).toBe(0);
  const firstBackup = cli('backup', '--keep', '2').out.trim();
  expect(cli('backup', '--keep', '2').code).toBe(0);
  expect(cli('backup', '--keep', '2').code).toBe(0);
  const directory = path.dirname(firstBackup);
  expect(fs.readdirSync(directory)).toHaveLength(2);
  expect(fs.existsSync(firstBackup)).toBe(false);
  fs.writeFileSync(`${new AuditLog().file('test')}.lock`, '');
  expect(cli('backup', '--keep', '2').code).toBe(1);
  expect(fs.readdirSync(directory)).toHaveLength(2);
});

it('rejects traversal and junctions on import/backup/rotation without touching targets', async () => {
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'dag.yaml'), JSON.stringify(dag()));
  fs.symlinkSync(
    outside,
    path.join(repo, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  expect(cli('import', '../outside/dag.yaml').code).toBe(1);
  expect(cli('import', 'linked/dag.yaml').code).toBe(1);
  expect(cli('import', 'dag.yaml').code).toBe(0);
  const backups = path.join(root, '.pixel-agents/backups');
  fs.mkdirSync(backups);
  fs.symlinkSync(
    outside,
    path.join(backups, 'test'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  expect(cli('backup').code).toBe(1);
  expect(fs.readdirSync(outside)).toEqual(['dag.yaml']);
  fs.unlinkSync(path.join(backups, 'test'));
  const result = cli('backup');
  expect(result.code).toBe(0);
  const dir = path.dirname(result.out.trim());
  const old = '2000-01-01T00-00-00-000Z-00000000-0000-0000-0000-000000000000';
  fs.symlinkSync(outside, path.join(dir, old), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(runTaskCommand(['backup', '--keep', '1'], repo, () => {})).rejects.toThrow();
  expect(fs.readdirSync(outside)).toEqual(['dag.yaml']);
  fs.unlinkSync(path.join(dir, old));
  fs.unlinkSync(path.join(repo, 'linked'));
});

it('audit failure before import prevents mutation', async () => {
  vi.spyOn(AuditLog.prototype, 'append').mockImplementation(() => {
    throw new Error('audit unavailable');
  });
  await expect(runTaskCommand(['import', 'dag.yaml'], repo)).rejects.toThrow('audit unavailable');
  expect((await open()).listTasks()).toEqual([]);
});

it('backs up an empty Project with an empty audit and honors the backup lock', () => {
  const result = cli('backup');
  expect(result).toMatchObject({ code: 0, err: '' });
  const directory = result.out.trim();
  expect(fs.readFileSync(path.join(directory, 'audit.jsonl'), 'utf8')).toBe('');
  const lock = path.join(path.dirname(directory), '.backup.lock');
  fs.writeFileSync(lock, '');
  expect(cli('backup').code).toBe(1);
  expect(fs.readdirSync(path.dirname(directory))).toHaveLength(2);
});
