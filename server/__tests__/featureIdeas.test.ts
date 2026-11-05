import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { buildSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IDEA_ASSUMPTION_TEXT, IDEA_QUESTIONS } from '../../core/src/ideaInterview.js';
import type { IdeaAnswer } from '../../core/src/messages.js';
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
  return {
    ...actual,
    fsyncSync: vi.fn(actual.fsyncSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    linkSync: vi.fn(actual.linkSync),
  };
});
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));

const interviewAnswers = (): IdeaAnswer[] =>
  IDEA_QUESTIONS.map((question) => ({
    questionId: question.id,
    choice: 'answer',
    text: 'Respuesta privada ' + question.id,
  }));
const expectedMarkdown = (text: unknown) =>
  '# Idea\n\n' +
  String(text)
    .split('\n')
    .map((line) => '    ' + line)
    .join('\n') +
  '\n\n## Respuestas\n\n' +
  IDEA_QUESTIONS.map(
    (question) => '### ' + question.label + '\n\n    Respuesta privada ' + question.id,
  ).join('\n\n') +
  '\n\n## Supuestos\n\nNinguno.\n';

describe('SA-109/110 draft ingress', () => {
  let root: string;
  let home: string;
  const request = (
    text: unknown = 'Una idea\ncon acentos: acción y ${sin ejecutar}',
    answers: unknown = interviewAnswers(),
  ) => ({
    projectId: 'ideas-project',
    requestId: 'submit-1',
    text,
    answers,
  });
  const file = (key: string) =>
    path.join(root, FEATURE_IDEAS_DIRECTORY, 'ideas-project', `${key}.md`);
  const bundleWriter = () => {
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
    return bundle;
  };
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(fs.fsyncSync).mockReset().mockImplementation(actual.fsyncSync);
    vi.mocked(fs.writeFileSync).mockReset().mockImplementation(actual.writeFileSync);
    vi.mocked(fs.linkSync).mockReset().mockImplementation(actual.linkSync);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-ideas-'));
    home = path.join(root, 'home');
    vi.stubEnv('HOME', home);
    childProcess.execFileSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
    fs.mkdirSync(path.join(root, '.git', 'softwareagents'), { recursive: true });
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
    childProcess.execFileSync('git', ['add', '.softwareagents/project.yaml'], {
      cwd: root,
      windowsHide: true,
    });
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
    const index = fs.readFileSync(path.join(root, '.git/index'));
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
      expectedMarkdown(request().text),
    );
    const audit = fs.readFileSync(new AuditLog().file('ideas-project'), 'utf8');
    expect(audit).toContain(
      createHash('sha256').update(expectedMarkdown(request().text)).digest('hex'),
    );
    for (const value of [
      audit,
      JSON.stringify(sent.mock.calls),
      JSON.stringify(logs.map((spy) => spy.mock.calls)),
    ]) {
      expect(value).not.toContain('con acentos');
      expect(value).not.toContain('Respuesta privada');
    }
    expect(launch).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalled();
    for (const call of exec.mock.calls)
      expect(call[1]?.some((arg) => ['ls-files', 'for-each-ref'].includes(String(arg)))).toBe(true);
    expect(fs.readFileSync(path.join(root, '.git/index'))).toEqual(index);
    expect(fs.readFileSync(path.join(root, '.softwareagents/project.yaml'))).toEqual(manifest);
    expect(fs.existsSync(path.join(root, '.git/softwareagents/work.sqlite3'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.softwareagents/brain'))).toBe(false);
    expect(readIdeas('r', true, root).ideas.map((idea) => idea.key)).toEqual(['FEAT-001']);
  });

  it('skips a real tracked draft deleted from disk, preserving its index entry', () => {
    fs.mkdirSync(path.dirname(file('FEAT-001')), { recursive: true });
    fs.writeFileSync(file('FEAT-001'), 'tracked content');
    childProcess.execFileSync(
      'git',
      ['add', '-f', '--', `${FEATURE_IDEAS_DIRECTORY}/ideas-project/FEAT-001.md`],
      { cwd: root, windowsHide: true },
    );
    const index = fs.readFileSync(path.join(root, '.git/index'));
    fs.unlinkSync(file('FEAT-001'));
    expect(submitIdea(request(), true, root).idea?.key).toBe('FEAT-002');
    expect(fs.existsSync(file('FEAT-001'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.git/index'))).toEqual(index);
  });

  it('skips a tracked draft whose directory differs only by case', () => {
    const tracked = `${FEATURE_IDEAS_DIRECTORY.replace('ideas', 'Ideas')}/ideas-project/FEAT-001.md`;
    childProcess.execFileSync(
      'git',
      [
        'update-index',
        '--add',
        '--cacheinfo',
        `100644,e69de29bb2d1d6434b8b29ae775ad8c2e48c5391,${tracked}`,
      ],
      { cwd: root, windowsHide: true },
    );
    expect(submitIdea(request(), true, root).idea?.key).toBe('FEAT-002');
  });

  it('reserves an existing runtime branch even without a WorkStore row', () => {
    const git = vi.mocked(childProcess.execFileSync);
    git
      .mockImplementationOnce(git.getMockImplementation()!)
      .mockReturnValueOnce('refs/heads/sa/FEAT-001-integration\n');
    expect(submitIdea(request(), true, root).idea?.key).toBe('FEAT-002');
  });

  it('excludes drafts locally and idempotently, preserving existing exclude contents', () => {
    const exclude = path.join(root, '.git/info/exclude');
    fs.writeFileSync(exclude, '# local rules\nkeep-me');
    const warn = vi.spyOn(console, 'warn');
    expect(submitIdea(request(), true, root).status).toBe('saved');
    expect(submitIdea(request(), true, root).status).toBe('saved');
    expect(fs.readFileSync(exclude, 'utf8')).toBe(
      `# local rules\nkeep-me\n/${FEATURE_IDEAS_DIRECTORY}/\n`,
    );
    expect(warn).not.toHaveBeenCalled();
    expect(
      childProcess.execFileSync('git', ['check-ignore', '--', file('FEAT-001')], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      }),
    ).toContain('FEAT-001.md');
  });

  it('saves with a fixed diagnostic if the local exclude cannot be updated', () => {
    fs.unlinkSync(path.join(root, '.git/info/exclude'));
    fs.mkdirSync(path.join(root, '.git/info/exclude'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(submitIdea(request(), true, root).status).toBe('saved');
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[featureIdeas] Local Git exclusion unavailable. Drafts can still be saved.',
    );
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

  it('reserves pending runs and requirements tasks before a FeatureSpec exists', () => {
    const db = new DatabaseSync(path.join(root, '.git/softwareagents/work.sqlite3'));
    try {
      runMigrations(db);
      db.exec(`INSERT INTO projects VALUES ('ideas-project', 'now');
        INSERT INTO feature_runs(project_id,feature_key,state) VALUES ('ideas-project','FEAT-001','{}');
        INSERT INTO tasks(project_id,key,type,status,priority,version,attempt,max_attempts,created_at,updated_at)
        VALUES ('ideas-project','FEAT-002','requirements','READY',0,1,0,3,'now','now');`);
      fs.mkdirSync(path.join(root, '.softwareagents/brain/features/requests'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.softwareagents/brain/features/requests/FEAT-003.md'),
        'pinned request',
      );
      expect(submitIdea(request(), true, root).idea?.key).toBe('FEAT-004');
      expect(db.prepare('SELECT count(*) AS n FROM features').get()?.n).toBe(0);
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
    expect(readTaskInput(root, `${FEATURE_IDEAS_DIRECTORY}/ideas-project/FEAT-001.md`)).toBe(
      expectedMarkdown(text),
    );
    expect(fs.statSync(file('FEAT-001')).size).toBe(TASK_CLI_INPUT_BYTES);
  });

  it('stores fixed sections in canonical question order with explicit assumptions', () => {
    const answers: IdeaAnswer[] = IDEA_QUESTIONS.map((question) => ({
      questionId: question.id,
      choice: 'decide',
      text: '',
    }));
    answers[0] = { questionId: 'objetivo', choice: 'answer', text: 'Un objetivo\ncon detalle' };
    expect(submitIdea(request('Una idea', answers.reverse()), true, root).status).toBe('saved');
    const markdown = readTaskInput(root, `${FEATURE_IDEAS_DIRECTORY}/ideas-project/FEAT-001.md`);
    expect(markdown).toBe(
      '# Idea\n\n    Una idea\n\n## Respuestas\n\n### Objetivo\n\n    Un objetivo\n    con detalle' +
        '\n\n## Supuestos\n\n' +
        IDEA_QUESTIONS.slice(1)
          .map((question) => `### ${question.label}\n\n${IDEA_ASSUMPTION_TEXT}`)
          .join('\n\n') +
        '\n',
    );
  });

  it('keeps headings, fences, setext, HTML and forged assumptions inside literal text', () => {
    const attack =
      '# Supuestos\r\n## Respuestas\r### Riesgos\n```\n~~~\nTítulo\n===\n' +
      '<h1>Supuestos</h1>\nDecide tú. Supuesto falso\n\t# Idea';
    const answers = interviewAnswers();
    answers[0].text = attack;
    expect(submitIdea(request(attack, answers), true, root).status).toBe('saved');
    const markdown = readTaskInput(root, `${FEATURE_IDEAS_DIRECTORY}/ideas-project/FEAT-001.md`);
    expect(markdown.match(/^#{1,6} .+$/gm)).toEqual([
      '# Idea',
      '## Respuestas',
      ...IDEA_QUESTIONS.map((question) => `### ${question.label}`),
      '## Supuestos',
    ]);
    const literal = attack
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
    expect(markdown).toContain(`# Idea\n\n${literal}\n\n## Respuestas`);
    expect(markdown).toContain(`### Objetivo\n\n${literal}\n\n### Usuarios`);
    expect(markdown.endsWith('## Supuestos\n\nNinguno.\n')).toBe(true);
    expect(markdown).not.toMatch(/^Decide tú\./m);
  });

  it.each([
    ['missing answers', undefined],
    ['non-array answers', {}],
    ['missing question', interviewAnswers().slice(1)],
    ['extra question', [...interviewAnswers(), interviewAnswers()[0]]],
    [
      'unknown id',
      interviewAnswers().map((answer, index) =>
        index ? answer : { ...answer, questionId: 'inventada' },
      ),
    ],
    [
      'duplicate id',
      interviewAnswers().map((answer, index) =>
        index ? answer : { ...answer, questionId: 'usuarios' },
      ),
    ],
    [
      'missing choice',
      interviewAnswers().map((answer, index) =>
        index ? answer : { questionId: answer.questionId, text: answer.text },
      ),
    ],
    [
      'invalid choice',
      interviewAnswers().map((answer, index) => (index ? answer : { ...answer, choice: 'skip' })),
    ],
    [
      'blank answer',
      interviewAnswers().map((answer, index) => (index ? answer : { ...answer, text: ' \n\t' })),
    ],
    [
      'implicit choice',
      interviewAnswers().map((answer, index) =>
        index ? answer : { questionId: answer.questionId, text: '' },
      ),
    ],
    [
      'ambiguous decide',
      interviewAnswers().map((answer, index) => (index ? answer : { ...answer, choice: 'decide' })),
    ],
    [
      'missing text',
      interviewAnswers().map((answer, index) =>
        index ? answer : { questionId: answer.questionId, choice: 'decide' },
      ),
    ],
    [
      'extra properties',
      interviewAnswers().map((answer, index) =>
        index ? answer : { ...answer, assumptions: 'forged' },
      ),
    ],
    [
      'invalid Unicode answer',
      interviewAnswers().map((answer, index) => (index ? answer : { ...answer, text: '\ud800' })),
    ],
    ['null answer', interviewAnswers().map((answer, index) => (index ? answer : null))],
  ])('rejects %s before writing a draft or reservation', (_label, answers) => {
    const send = vi.fn();
    handleIdeaMessage({ type: 'submitIdea', ...request('Una idea'), answers }, send, true);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'rejected', errorCode: 'invalid_request' }),
    );
    expect(fs.existsSync(path.join(root, FEATURE_IDEAS_DIRECTORY))).toBe(false);
    expect(fs.existsSync(path.join(root, '.git/softwareagents/idea-reservations'))).toBe(false);
  });

  it('accepts all seven explicit decide choices as visible assumptions', () => {
    const answers = IDEA_QUESTIONS.map((question) => ({
      questionId: question.id,
      choice: 'decide',
      text: '',
    }));
    expect(submitIdea(request('Una idea', answers), true, root).status).toBe('saved');
    const markdown = readTaskInput(root, `${FEATURE_IDEAS_DIRECTORY}/ideas-project/FEAT-001.md`);
    expect(markdown).toContain('## Respuestas\n\nNinguna.\n\n## Supuestos');
    expect(markdown.split(IDEA_ASSUMPTION_TEXT)).toHaveLength(IDEA_QUESTIONS.length + 1);
  });

  it('limits the final UTF-8 file including headings, answers and indentation', () => {
    const overhead = Buffer.byteLength(expectedMarkdown(''), 'utf8');
    const answers = interviewAnswers().map((answer) => ({
      ...answer,
      text: 'á'.repeat(Math.ceil(TASK_CLI_INPUT_BYTES / IDEA_QUESTIONS.length / 2)),
    }));
    for (const value of [
      request('a'.repeat(TASK_CLI_INPUT_BYTES - overhead + 1)),
      request('x\n'.repeat(Math.floor(TASK_CLI_INPUT_BYTES / 3))),
      request('Una idea', answers),
    ]) {
      expect(submitIdea(value, true, root)).toMatchObject({
        status: 'rejected',
        errorCode: 'too_large',
      });
      expect(fs.existsSync(path.join(root, FEATURE_IDEAS_DIRECTORY))).toBe(false);
    }
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
    fs.writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/linked\n');
    fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${gitdir}`);
    fs.copyFileSync(
      path.join(root, '.softwareagents/project.yaml'),
      path.join(linked, '.softwareagents/project.yaml'),
    );
    expect(submitIdea(request(), true, root).idea?.key).toBe('FEAT-001');
    expect(submitIdea(request('other checkout'), true, linked).idea?.key).toBe('FEAT-002');
    expect(readTaskInput(linked, `${FEATURE_IDEAS_DIRECTORY}/ideas-project/FEAT-002.md`)).toBe(
      expectedMarkdown('other checkout'),
    );
    expect(submitIdea(request(), true, root).idea?.key).toBe('FEAT-003');
    expect(
      fs
        .readFileSync(path.join(root, '.git/info/exclude'), 'utf8')
        .split(`/${FEATURE_IDEAS_DIRECTORY}/`),
    ).toHaveLength(2);
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
      expectedMarkdown(request().text),
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
      expectedMarkdown(request().text),
    );
  });

  it('releases its own reservation after repeated write failures without consuming ids', () => {
    let syncs = 0;
    vi.mocked(fs.fsyncSync).mockImplementation(() => {
      if (++syncs % 2 === 0) throw new Error('private filesystem diagnostic');
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(submitIdea(request(), true, root)).toMatchObject({
        status: 'failed',
        errorCode: 'unavailable',
        idea: null,
      });
      expect(
        fs.readdirSync(path.join(root, '.git/softwareagents/idea-reservations/ideas-project')),
      ).toEqual([]);
    }
    expect(fs.existsSync(file('FEAT-001'))).toBe(false);
    expect(readIdeas('r', true, root).ideas).toEqual([]);
    vi.mocked(fs.fsyncSync).mockRestore();
    expect(submitIdea(request(), true, root).idea?.key).toBe('FEAT-001');
  });

  it('releases reservations whose own metadata sync fails', () => {
    vi.mocked(fs.fsyncSync).mockImplementation(() => {
      throw new Error('sync failure');
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(submitIdea(request(), true, root).status).toBe('failed');
      expect(
        fs.readdirSync(path.join(root, '.git/softwareagents/idea-reservations/ideas-project')),
      ).toEqual([]);
    }
    vi.mocked(fs.fsyncSync).mockRestore();
    expect(submitIdea(request(), true, root).idea?.key).toBe('FEAT-001');
  });

  it('does not remove a replacement reservation while handling a failed write', () => {
    let syncs = 0;
    vi.mocked(fs.fsyncSync).mockImplementation(() => {
      if (++syncs === 2) {
        const reservation = path.join(
          root,
          '.git/softwareagents/idea-reservations/ideas-project/FEAT-001',
        );
        fs.writeFileSync(`${reservation}.replacement`, 'another owner');
        fs.renameSync(`${reservation}.replacement`, reservation);
        throw new Error('write failed');
      }
    });
    expect(submitIdea(request(), true, root).status).toBe('failed');
    expect(
      fs.readFileSync(
        path.join(root, '.git/softwareagents/idea-reservations/ideas-project/FEAT-001'),
        'utf8',
      ),
    ).toBe('another owner');
    expect(fs.existsSync(file('FEAT-001'))).toBe(false);
  });

  it('keeps partial staging outside snapshots, and publishes only synced validated content', () => {
    const write = fs.writeFileSync;
    const actual = vi.mocked(write).getMockImplementation()!;
    vi.mocked(write).mockImplementation((...args: Parameters<typeof write>) => {
      if (typeof args[0] === 'number' && args[1] === expectedMarkdown(request().text)) {
        actual(args[0], 'partial', 'utf8');
        expect(fs.existsSync(file('FEAT-001'))).toBe(false);
        expect(readIdeas('during-write', true, root).ideas).toEqual([]);
        // Restore descriptor position for the real full write below.
        fs.ftruncateSync(args[0], 0);
        fs.writeSync(args[0], String(args[1]), 0, 'utf8');
        return;
      }
      return actual(...args);
    });
    expect(submitIdea(request(), true, root).idea?.key).toBe('FEAT-001');
    expect(fs.readFileSync(file('FEAT-001'), 'utf8')).toBe(expectedMarkdown(request().text));
    expect(fs.readdirSync(path.dirname(file('FEAT-001')))).toEqual(['FEAT-001.md']);
    const reservation = JSON.parse(
      fs.readFileSync(
        path.join(root, '.git/softwareagents/idea-reservations/ideas-project/FEAT-001'),
        'utf8',
      ),
    );
    expect(reservation).toMatchObject({
      pid: process.pid,
      checkout: root,
      destination: `${FEATURE_IDEAS_DIRECTORY}/ideas-project/FEAT-001.md`,
    });
    expect(reservation.owner).toBeTruthy();
    expect(reservation.staging).toContain(reservation.owner);
  });

  it('does not overwrite a destination created just before publication', () => {
    const link = vi.mocked(fs.linkSync).getMockImplementation()!;
    vi.mocked(fs.linkSync).mockImplementationOnce((source, destination) => {
      fs.writeFileSync(destination, 'another writer');
      link(source, destination);
    });
    expect(submitIdea(request(), true, root).idea?.key).toBe('FEAT-002');
    expect(fs.readFileSync(file('FEAT-001'), 'utf8')).toBe('another writer');
    expect(
      fs.existsSync(
        path.join(root, '.git/softwareagents/idea-reservations/ideas-project/FEAT-001'),
      ),
    ).toBe(false);
  });

  it('validates staged contents before publication and releases a failed validation id', () => {
    let syncs = 0;
    vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
      if (++syncs === 2) fs.writeSync(fd, 'tampered', 0, 'utf8');
    });
    vi.mocked(fs.linkSync).mockClear();
    expect(submitIdea(request(), true, root).errorCode).toBe('unsafe_storage');
    expect(fs.linkSync).not.toHaveBeenCalled();
    expect(fs.existsSync(file('FEAT-001'))).toBe(false);
    vi.mocked(fs.fsyncSync).mockRestore();
    expect(submitIdea(request(), true, root).idea?.key).toBe('FEAT-001');
  });

  it('leaves an inspectable owned reservation after process interruption, hiding partial staging', async () => {
    const child = childProcess.fork(
      path.join(__dirname, 'fixtures/submit-feature-idea.cjs'),
      [bundleWriter()],
      {
        env: { ...process.env, HOME: home },
        silent: true,
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve());
        child.once('error', reject);
        child.once('exit', () => reject(new Error('Draft child exited before readiness')));
      });
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
      child.send({
        root,
        text: 'must not be published',
        answers: interviewAnswers(),
        interrupt: true,
      });
      expect(await exited).toBe(73);
      const reservation = JSON.parse(
        fs.readFileSync(
          path.join(root, '.git/softwareagents/idea-reservations/ideas-project/FEAT-001'),
          'utf8',
        ),
      );
      expect(reservation).toMatchObject({ pid: child.pid, checkout: root });
      expect(reservation.owner).toBeTruthy();
      expect(fs.readFileSync(path.join(root, reservation.staging), 'utf8')).toBe(
        'interrupted draft',
      );
      expect(fs.existsSync(file('FEAT-001'))).toBe(false);
      expect(readIdeas('after-crash', true, root).ideas).toEqual([]);
      expect(submitIdea(request(), true, root).idea?.key).toBe('FEAT-002');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
    }
  });

  it('allocates distinct ids for genuinely concurrent processes', async () => {
    const bundle = bundleWriter();
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
            child.send({ root, text: `concurrent idea ${index}`, answers: interviewAnswers() });
          }),
      );
      const saved = await Promise.all(results);
      expect(new Set(saved.map((result) => result.key)).size).toBe(4);
      for (const result of saved)
        expect(
          readTaskInput(root, `${FEATURE_IDEAS_DIRECTORY}/ideas-project/${result.key}.md`),
        ).toBe(expectedMarkdown(result.text));
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
