import { DatabaseSync } from 'node:sqlite';

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QA_MAX_TEST_FILES } from '../src/constants.js';
import { runIsolatedVitest } from '../src/evalCriteria.js';
import { loadModelPolicy } from '../src/modelPolicy.js';
import { qaCommands, qaRequestedCommands, qaTestFiles } from '../src/qa.js';
import { reviewReworkRounds } from '../src/reviewAttempts.js';
import type { ReviewerRequest } from '../src/reviewer.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import type { TaskRecord } from '../src/workstore/WorkStore.js';

vi.setConfig({ testTimeout: 30_000 });
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));
let root: string;
let tree: string;
let scratch: string;
let link: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: tree, windowsHide: true, encoding: 'utf8' });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-verifier-'));
  tree = path.join(root, 'tree');
  scratch = path.join(root, 'scratch');
  fs.mkdirSync(path.join(tree, 'server/__tests__'), { recursive: true });
  fs.mkdirSync(scratch);
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) vi.stubEnv(key, root);
  vi.stubEnv('QA_SECRET_SENTINEL', 'must-not-leak');
  link = path.join(tree, 'node_modules');
  fs.symlinkSync(
    path.dirname(path.dirname(require.resolve('vitest/package.json'))),
    link,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
});
afterEach(() => {
  // Only unlink the fixture junction. Retain test evidence under the isolated TEMP.
  if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(link);
  vi.unstubAllEnvs();
});
const source = (text: string, file = 'server/__tests__/check.test.ts') =>
  fs.writeFileSync(path.join(tree, file), text);
const verify = () => runIsolatedVitest(tree, scratch, 'server/__tests__/check.test.ts');

describe('Shared isolated QA verifier', () => {
  it('counts valid Reviewer and QA rejections, excluding historical infrastructure attempts', () => {
    const task = {
      attempt: 99,
      review_reports: [
        { report: { verdict: 'approve' } },
        { report: { verdict: 'request_changes' } },
      ],
      test_reports: [
        { report: { verdict: 'fail' } },
        { report: { verdict: 'pass' } },
        { report: { verdict: 'not_tested' } },
      ],
    } as TaskRecord;
    expect(reviewReworkRounds(task)).toBe(2);
  });
  it('accepts only one bounded request envelope of runtime command IDs', () => {
    const commands = [
      {
        command: 'vitest:server/__tests__/check.test.ts',
        result: 'pass' as const,
        passed: 1,
        failed: 0,
      },
    ];
    expect(
      qaRequestedCommands(
        JSON.stringify({ requestCommands: [commands[0].command] }),
        commands,
        false,
      ),
    ).toEqual([commands[0].command]);
    for (const value of [
      { requestCommands: ['npm install'] },
      { requestCommands: [] },
      { requestCommands: [commands[0].command, commands[0].command] },
      { requestCommands: [commands[0].command], argv: ['node', 'evil.js'] },
    ])
      expect(() => qaRequestedCommands(JSON.stringify(value), commands, false)).toThrow();
    expect(() =>
      qaRequestedCommands(
        JSON.stringify({ requestCommands: [commands[0].command] }),
        commands,
        true,
      ),
    ).toThrow();
  });
  it('isolates environment and Windows os.homedir, runs only selected files and returns JSON counts', async () => {
    source(
      "import { it, expect } from 'vitest'; import os from 'os'; import fs from 'fs'; import path from 'path'; it('isolates', () => { const runtime = path.dirname(process.env.HOME); expect(fs.existsSync(path.join(runtime, 'vitest.config.mjs'))).toBe(true); expect(fs.existsSync(path.join(runtime, 'isolated-home.mjs'))).toBe(true); fs.writeFileSync(path.join(process.env.HOME, 'runtime-output'), 'isolated'); expect(fs.existsSync(path.join(process.env.HOME, 'runtime-output'))).toBe(true); expect(process.env.QA_SECRET_SENTINEL).toBeUndefined(); expect(os.homedir()).toBe(process.env.HOME); expect(process.env.USERPROFILE).toBe(process.env.HOME); expect(process.env.HOME).not.toBe(" +
        JSON.stringify(root) +
        '); });',
    );
    source(
      "throw new Error('unselected test must not execute')",
      'server/__tests__/unselected.test.ts',
    );
    expect(await verify()).toEqual({ result: 'pass', passed: 1, failed: 0 });
    expect(fs.readdirSync(scratch)).toEqual([]);
  });
  it('distinguishes failing assertions from verifier infrastructure failures', async () => {
    source("import {it,expect} from 'vitest'; it('broken', () => expect(true).toBe(false));");
    expect(await verify()).toEqual({ result: 'fail', passed: 0, failed: 1 });
    source("throw new Error('cannot load suite');");
    await expect(verify()).rejects.toThrow(/infrastructure/);
    source("import {it} from 'vitest'; it.skip('unverified', () => {});");
    await expect(verify()).rejects.toThrow(/infrastructure/);
  });
  it.each(['', 'if (false) expect(true).toBe(true);'])(
    'fails QA when a test executes no assertion (%s)',
    async (body) => {
      // qaCommands owns the junction and validates its removal and the unchanged tree.
      fs.unlinkSync(link);
      git('init', '-b', 'main', '--separate-git-dir', path.join(root, 'metadata'));
      source("import { it, expect } from 'vitest'; it('no assertion', () => { " + body + ' });');
      git('add', 'server');
      git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-m',
        'fixture',
      );
      const input = {
        worktree: tree,
        reviewRef: { sha: git('rev-parse', 'HEAD').trim() },
        files: ['server/__tests__/check.test.ts'],
        task: { changeZones: [], testZones: [] },
      } as unknown as ReviewerRequest;
      expect(await qaCommands(input, scratch, new AbortController().signal)).toEqual([
        { command: 'vitest:server/__tests__/check.test.ts', result: 'fail', passed: 0, failed: 1 },
      ]);
      expect(fs.readdirSync(scratch)).toEqual([]);
      expect(fs.existsSync(link)).toBe(false);
      expect(git('status', '--porcelain', '--ignored').trim()).toBe('');
    },
  );
  it.each(['allure-results/output.json', '.vite/output.json'])(
    'reports a forbidden runtime write %s with escaped path and verification phase',
    async (file) => {
      fs.unlinkSync(link);
      git('init', '-b', 'main', '--separate-git-dir', path.join(root, 'metadata'));
      source(
        "import { it, expect } from 'vitest'; import fs from 'fs'; it('writes', () => { fs.mkdirSync(" +
          JSON.stringify(path.dirname(file)) +
          ', { recursive: true }); fs.writeFileSync(' +
          JSON.stringify(file) +
          ", 'output'); expect(true).toBe(true); });",
      );
      git('add', 'server');
      git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-m',
        'fixture',
      );
      const input = {
        worktree: tree,
        reviewRef: { sha: git('rev-parse', 'HEAD').trim() },
        files: ['server/__tests__/check.test.ts'],
        task: { changeZones: [], testZones: [] },
      } as unknown as ReviewerRequest;
      await expect(qaCommands(input, scratch, new AbortController().signal)).rejects.toThrow(
        'cambio durante la verificación: Eval modified a forbidden path: ' + JSON.stringify(file),
      );
      expect(fs.existsSync(link)).toBe(false);
      expect(fs.readdirSync(scratch)).toEqual([]);
    },
  );
  it('selects changed, mirror and declared tests only, and rejects unbounded sets', () => {
    git('init', '-b', 'main', '--separate-git-dir', path.join(root, 'metadata'));
    source('// fixture');
    source('// fixture', 'server/__tests__/unrelated.test.ts');
    source('// fixture', 'server/__tests__/declared.test.ts');
    git('add', 'server');
    const input = {
      worktree: tree,
      files: [],
      task: {
        changeZones: ['server/src/check.ts'],
        testZones: ['server/__tests__/declared.test.ts'],
      },
    } as unknown as ReviewerRequest;
    expect(qaTestFiles(input)).toEqual([
      'server/__tests__/check.test.ts',
      'server/__tests__/declared.test.ts',
    ]);
    for (let i = 0; i < QA_MAX_TEST_FILES; i++)
      source('// fixture', 'server/__tests__/extra' + i + '.test.ts');
    git('add', 'server');
    input.task.testZones = ['server/__tests__/'];
    expect(() => qaTestFiles(input)).toThrow(/bounded/);
  });
  it('recovers QA without consuming rounds even when the lease expires before an Execution is created', async () => {
    git('init', '-b', 'main');
    const store = await openWorkStore({ repositoryPath: tree, projectId: 'test' });
    const key = 'FEAT-001-T01';
    store.createTask({ key, type: 'code', status: 'QA' });
    const db = new DatabaseSync(path.join(tree, '.git/softwareagents/work.sqlite3'));
    try {
      db.prepare('UPDATE tasks SET review_ref = ? WHERE key = ?').run(
        JSON.stringify({
          branch: 'sa/' + key + '-developer',
          sha: 'a'.repeat(40),
          base: 'b'.repeat(40),
        }),
        key,
      );
      await store.claimReview(key, store.getTask(key)!.version, 'qa-test', 'qa');
      expect(store.getTask(key)!.attempt).toBe(0);
      db.prepare('UPDATE tasks SET lease_expires_at = ? WHERE key = ?').run(
        new Date(0).toISOString(),
        key,
      );
      await store.recoverExpiredLeases();
      expect(store.getTask(key)).toMatchObject({ status: 'QA', attempt: 0, lease_owner: null });
    } finally {
      db.close();
      store.close();
    }
  });
  it('accepts explicit QA preferences and preserves review fallback for historical policies', () => {
    fs.mkdirSync(path.join(tree, '.softwareagents/agents'), { recursive: true });
    const file = path.join(tree, '.softwareagents/agents/model-policy.yaml');
    fs.writeFileSync(file, 'review:\n  - executor: claude\n');
    expect(loadModelPolicy(tree).test_analysis).toEqual([{ executor: 'claude' }]);
    fs.writeFileSync(file, 'review:\n  - executor: claude\ntest_analysis:\n  - executor: codex\n');
    expect(loadModelPolicy(tree).test_analysis).toEqual([{ executor: 'codex' }]);
  });
});
