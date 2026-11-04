import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { buildSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditLog } from '../src/auditLog.js';
import type { ClientMessageContext } from '../src/clientMessageHandler.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { readTaskInput } from '../src/commands/taskFiles.js';
import * as company from '../src/companyControl.js';
import { FEATURE_IDEAS_DIRECTORY, TASK_CLI_INPUT_BYTES } from '../src/constants.js';
import { handleIdeaMessage, readIdeas, submitIdea } from '../src/featureIdeas.js';
import { runMigrations } from '../src/workstore/migrations.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn), execFileSync: vi.fn(actual.execFileSync) };
});
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));

describe('SA-109 draft ingress', () => {
  let root: string;
  let home: string;
  const request = (text: unknown = 'Una idea\ncon acentos: acción y ${sin ejecutar}') => ({
    projectId: 'ideas-project',
    requestId: 'submit-1',
    text,
  });
  const file = (key: string) =>
    path.join(root, FEATURE_IDEAS_DIRECTORY, 'ideas-project', `${key}.md`);
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-ideas-'));
    home = path.join(root, 'home');
    vi.stubEnv('HOME', home);
    fs.mkdirSync(path.join(root, '.git', 'softwareagents'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'index'), 'unchanged index');
    fs.mkdirSync(path.join(root, '.softwareagents'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.softwareagents/project.yaml'),
      JSON.stringify({
        apiVersion: 'softwareagents.io/v1alpha1',
        kind: 'Project',
        id: 'ideas-project',
        name: 'Ideas',
        repo: { remote: 'https://example.com/ideas.git', defaultBranch: 'main' },
        brain: { path: '.softwareagents/brain' },
      }),
    );
    vi.spyOn(company, 'companyWorkspaceRoot').mockReturnValue(root);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('privilege first: denies before probing any Project, including a client-selected id', () => {
    expect(submitIdea(request(), false, '/does-not-exist')).toMatchObject({
      status: 'rejected',
      errorCode: 'denied',
    });
    expect(readIdeas('r', false, '/does-not-exist')).toMatchObject({
      canSubmit: false,
      projectId: null,
      errorCode: 'denied',
      ideas: [],
    });
    const send = vi.fn();
    handleIdeaMessage({ type: 'submitIdea', ...request(), id: 'FEAT-999' }, send, false);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ errorCode: 'denied' }));
    handleIdeaMessage({ type: 'submitIdea', ...request(), id: 'FEAT-999' }, send, true);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ errorCode: 'invalid_request' }),
    );
    expect(fs.existsSync(path.join(root, FEATURE_IDEAS_DIRECTORY))).toBe(false);
    expect(fs.existsSync(home)).toBe(false);
  });

  it('dispatches privileged drafts without starting work, changing tracked files or the index, or logging text', () => {
    const spawn = vi.mocked(childProcess.spawn);
    spawn.mockClear();
    const exec = vi.mocked(childProcess.execFileSync);
    exec.mockClear();
    const manifest = fs.readFileSync(path.join(root, '.softwareagents/project.yaml'));
    const launch = vi.fn();
    const ctx = {
      privileged: true,
      cache: null,
      store: { getAdapter: () => ({ launchAgent: launch }) },
    } as unknown as ClientMessageContext;
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
    const sent = vi.fn();
    handleClientMessage({ type: 'submitIdea', ...request() }, sent, ctx);
    expect(sent).toHaveBeenCalledOnce();
    expect(sent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'saved',
        errorCode: null,
        idea: {
          key: 'FEAT-001',
          command:
            'pixel-agents feature run FEAT-001 --request .softwareagents/ideas/ideas-project/FEAT-001.md --confirm',
        },
      }),
    );
    expect(readTaskInput(root, `${FEATURE_IDEAS_DIRECTORY}/ideas-project/FEAT-001.md`)).toBe(
      request().text,
    );
    const audit = fs.readFileSync(new AuditLog().file('ideas-project'), 'utf8');
    expect(audit).toContain(createHash('sha256').update(String(request().text)).digest('hex'));
    for (const value of [
      audit,
      JSON.stringify(sent.mock.calls),
      JSON.stringify(logs.map((spy) => spy.mock.calls)),
    ])
      expect(value).not.toContain('con acentos');
    expect(launch).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(root, '.git/index'), 'utf8')).toBe('unchanged index');
    expect(fs.readFileSync(path.join(root, '.softwareagents/project.yaml'))).toEqual(manifest);
    expect(fs.existsSync(path.join(root, '.git/softwareagents/work.sqlite3'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.softwareagents/brain'))).toBe(false);
    expect(readIdeas('r', true, root).ideas.map((idea) => idea.key)).toEqual(['FEAT-001']);
  });

  it('dispatch defaults to unprivileged and VS Code returns an explicit reason', () => {
    const ctx = {
      cache: null,
      store: { getAdapter: () => ({}) },
    } as unknown as ClientMessageContext;
    const send = vi.fn();
    handleClientMessage({ type: 'submitIdea', ...request() }, send, ctx);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ errorCode: 'denied' }));
    handleIdeaMessage({ type: 'requestIdeas', requestId: 'r' }, send, true, false);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ canSubmit: false, errorCode: 'unsupported_adapter' }),
    );
    handleIdeaMessage({ type: 'submitIdea', ...request() }, send, true, false);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'rejected', errorCode: 'unsupported_adapter' }),
    );
  });

  it('skips registered features, saved ideas and unregistered FeatureSpecs; hides promoted drafts', () => {
    const db = new DatabaseSync(path.join(root, '.git/softwareagents/work.sqlite3'));
    try {
      runMigrations(db);
      db.exec(
        "INSERT INTO projects VALUES ('ideas-project', 'now'); INSERT INTO features(project_id,key,doc_path,git_sha,status) VALUES ('ideas-project','FEAT-001','spec.yaml','sha','in_review')",
      );
      fs.mkdirSync(path.join(root, FEATURE_IDEAS_DIRECTORY, 'ideas-project'), { recursive: true });
      fs.writeFileSync(file('FEAT-001'), 'promoted');
      fs.writeFileSync(file('FEAT-002'), 'existing idea');
      fs.mkdirSync(path.join(root, '.softwareagents/brain/features'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.softwareagents/brain/features/FEAT-003.yaml'),
        'not registered yet',
      );
      expect(submitIdea(request(), true, root).idea?.key).toBe('FEAT-004');
      expect(fs.readFileSync(file('FEAT-002'), 'utf8')).toBe('existing idea');
      expect(readIdeas('r', true, root).ideas.map((idea) => idea.key)).toEqual([
        'FEAT-002',
        'FEAT-004',
      ]);
      for (const table of ['tasks', 'executions', 'feature_runs', 'human_decisions'])
        expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it.each([
    ['empty', '', 'empty_text'],
    ['whitespace', ' \n\t ', 'empty_text'],
    ['non-string', null, 'invalid_request'],
    ['oversized UTF-8', 'á'.repeat(TASK_CLI_INPUT_BYTES / 2 + 1), 'too_large'],
    ['invalid Unicode', '\ud800', 'invalid_request'],
  ])('rejects %s text', (_label, text, code) => {
    expect(submitIdea(request(text), true, root)).toMatchObject({
      status: 'rejected',
      errorCode: code,
    });
    expect(fs.existsSync(path.join(root, FEATURE_IDEAS_DIRECTORY))).toBe(false);
  });

  it('accepts exactly 1 MiB through the real request reader', () => {
    const text = 'á'.repeat(TASK_CLI_INPUT_BYTES / 2);
    expect(submitIdea(request(text), true, root).status).toBe('saved');
    expect(readTaskInput(root, `${FEATURE_IDEAS_DIRECTORY}/ideas-project/FEAT-001.md`)).toBe(text);
    expect(fs.statSync(file('FEAT-001')).size).toBe(TASK_CLI_INPUT_BYTES);
  });

  it('uses the first gap and reports exhaustion without overwriting an idea', () => {
    fs.mkdirSync(path.join(root, FEATURE_IDEAS_DIRECTORY, 'ideas-project'), { recursive: true });
    fs.writeFileSync(file('FEAT-001'), 'first');
    fs.writeFileSync(file('FEAT-003'), 'third');
    expect(submitIdea(request(), true, root).idea?.key).toBe('FEAT-002');
    for (let id = 4; id <= 999; id++)
      fs.writeFileSync(file(`FEAT-${String(id).padStart(3, '0')}`), 'reserved');
    expect(submitIdea(request(), true, root).errorCode).toBe('ids_exhausted');
    expect(fs.readFileSync(file('FEAT-001'), 'utf8')).toBe('first');
  });

  it('reserves ids across linked worktrees sharing the same Project and Git common dir', () => {
    const linked = path.join(root, 'linked');
    const gitdir = path.join(root, '.git/worktrees/linked');
    fs.mkdirSync(path.join(linked, '.softwareagents'), { recursive: true });
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, 'commondir'), '../..');
    fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${gitdir}`);
    fs.copyFileSync(
      path.join(root, '.softwareagents/project.yaml'),
      path.join(linked, '.softwareagents/project.yaml'),
    );
    expect(submitIdea(request(), true, root).idea?.key).toBe('FEAT-001');
    expect(submitIdea(request('other checkout'), true, linked).idea?.key).toBe('FEAT-002');
    expect(readTaskInput(linked, `${FEATURE_IDEAS_DIRECTORY}/ideas-project/FEAT-002.md`)).toBe(
      'other checkout',
    );
    expect(submitIdea(request(), true, root).idea?.key).toBe('FEAT-003');
    expect(readIdeas('r', true, root).ideas.map((idea) => idea.key)).toEqual([
      'FEAT-001',
      'FEAT-003',
    ]);
  });

  it('does not relabel saved drafts when the bound manifest changes Project identity', () => {
    expect(submitIdea(request(), true, root).status).toBe('saved');
    const manifest = path.join(root, '.softwareagents/project.yaml');
    const value = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    fs.writeFileSync(manifest, JSON.stringify({ ...value, id: 'other-project' }));
    expect(readIdeas('r', true, root)).toMatchObject({ projectId: 'other-project', ideas: [] });
    expect(submitIdea(request(), true, root).errorCode).toBe('unknown_project');
    expect(submitIdea({ ...request(), projectId: 'other-project' }, true, root).idea?.key).toBe(
      'FEAT-001',
    );
    expect(readTaskInput(root, `${FEATURE_IDEAS_DIRECTORY}/ideas-project/FEAT-001.md`)).toBe(
      request().text,
    );
  });

  it('explains unbound, missing and invalid Projects without throwing', () => {
    vi.mocked(company.companyWorkspaceRoot).mockReturnValue(undefined);
    expect(readIdeas('r', true).errorCode).toBe('no_project');
    expect(submitIdea(request(), true).errorCode).toBe('no_project');
    fs.unlinkSync(path.join(root, '.softwareagents/project.yaml'));
    expect(readIdeas('r', true, root).errorCode).toBe('missing_manifest');
    expect(submitIdea(request(), true, root).errorCode).toBe('missing_manifest');
    fs.writeFileSync(path.join(root, '.softwareagents/project.yaml'), 'kind: invalid');
    expect(readIdeas('r', true, root).errorCode).toBe('invalid_manifest');
    expect(submitIdea(request(), true, root).errorCode).toBe('invalid_manifest');
  });

  it('rejects a Project mismatch and an existing unreadable WorkStore', () => {
    expect(submitIdea({ ...request(), projectId: 'other' }, true, root).errorCode).toBe(
      'unknown_project',
    );
    fs.writeFileSync(path.join(root, '.git/softwareagents/work.sqlite3'), 'corrupt');
    expect(submitIdea(request(), true, root).errorCode).toBe('unavailable');
    expect(fs.existsSync(path.join(root, FEATURE_IDEAS_DIRECTORY))).toBe(false);
  });

  it('refuses a junction/symlink at the target directory without touching its destination', () => {
    const outside = path.join(root, 'untouched');
    fs.mkdirSync(outside);
    const link = path.join(root, FEATURE_IDEAS_DIRECTORY);
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(submitIdea(request(), true, root).errorCode).toBe('unsafe_storage');
      expect(readIdeas('r', true, root).errorCode).toBe('unsafe_storage');
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.unlinkSync(link);
    }
  });

  it('refuses a junction at the target filename and hardlinks to regular files', () => {
    fs.mkdirSync(path.join(root, FEATURE_IDEAS_DIRECTORY, 'ideas-project'), { recursive: true });
    const outside = path.join(root, 'untouched');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, file('FEAT-001'), process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(submitIdea(request(), true, root).errorCode).toBe('unsafe_storage');
    } finally {
      fs.unlinkSync(file('FEAT-001'));
    }
    const other = path.join(root, 'unchanged.md');
    fs.writeFileSync(other, 'untouched');
    fs.linkSync(other, file('FEAT-001'));
    expect(submitIdea(request(), true, root).errorCode).toBe('unsafe_storage');
    expect(fs.readFileSync(other, 'utf8')).toBe('untouched');
  });

  it('returns saved with its id even if audit confirmation fails', () => {
    vi.spyOn(AuditLog.prototype, 'append').mockImplementation(() => {
      throw new Error('private diagnostic');
    });
    expect(submitIdea(request(), true, root)).toMatchObject({
      status: 'saved',
      errorCode: 'audit_failed',
      idea: { key: 'FEAT-001' },
    });
    expect(readTaskInput(root, `${FEATURE_IDEAS_DIRECTORY}/ideas-project/FEAT-001.md`)).toBe(
      request().text,
    );
  });

  it('removes its own partial file on write failure and returns only a fixed code', () => {
    vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
      if (fs.fstatSync(fd).size) throw new Error('private filesystem diagnostic');
    });
    expect(submitIdea(request(), true, root)).toMatchObject({
      status: 'failed',
      errorCode: 'unavailable',
      idea: null,
    });
    expect(fs.existsSync(file('FEAT-001'))).toBe(false);
    expect(readIdeas('r', true, root).ideas).toEqual([]);
    vi.mocked(fs.fsyncSync).mockRestore();
  });

  it('allocates distinct ids for genuinely concurrent processes', async () => {
    const bundle = path.join(home, 'feature-ideas.cjs');
    buildSync({
      entryPoints: [path.join(__dirname, '../src/featureIdeas.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['node:sqlite'],
      logLevel: 'silent',
    });
    const children = Array.from({ length: 4 }, () =>
      childProcess.fork(path.join(__dirname, 'fixtures/submit-feature-idea.cjs'), [bundle], {
        env: { ...process.env, HOME: home },
        silent: true,
      }),
    );
    try {
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve, reject) => {
              child.once('error', reject);
              child.once('exit', () => reject(new Error('Draft child exited before readiness')));
              child.once('message', () => resolve());
            }),
        ),
      );
      const results = children.map(
        (child, index) =>
          new Promise<{ key: string; text: string }>((resolve, reject) => {
            child.on('error', reject);
            child.on('exit', (code) => {
              if (code) reject(new Error('Draft child failed'));
            });
            child.on('message', (message: { status?: string; idea?: { key: string } }) => {
              if (message.status === 'saved' && message.idea)
                resolve({ key: message.idea.key, text: `concurrent idea ${index}` });
              else reject(new Error('Draft was not saved'));
            });
            child.send({ root, text: `concurrent idea ${index}` });
          }),
      );
      const saved = await Promise.all(results);
      expect(new Set(saved.map((result) => result.key)).size).toBe(4);
      for (const result of saved)
        expect(
          readTaskInput(root, `${FEATURE_IDEAS_DIRECTORY}/ideas-project/${result.key}.md`),
        ).toBe(result.text);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once('exit', () => resolve());
        });
      }
    }
  }, 30_000);
});
