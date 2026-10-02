import * as childProcess from 'child_process';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { BoardWatcher } from '../src/boardWatcher.js';
import { claudeQuota, codexQuota } from '../src/quotaReader.js';

vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
}));

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('../src/companyControl.js', () => ({ readAutopilot: () => undefined }));
vi.mock('../src/quotaReader.js', () => ({
  claudeQuota: vi.fn(() => undefined),
  codexQuota: vi.fn(() => undefined),
}));

let DatabaseSync: typeof import('node:sqlite').DatabaseSync | undefined;
try {
  ({ DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite',
  ) as typeof import('node:sqlite'));
} catch {
  // Older Node hosts have no live claims or progress.
}

describe('BoardWatcher characterization', () => {
  const nowS = 100_000;
  let root: string;
  let workspace: string;
  let commonDir: string;
  let boardFile: string;
  let store: AgentStateStore;
  let watcher: BoardWatcher;

  function writeBoard(): void {
    fs.writeFileSync(
      boardFile,
      JSON.stringify({
        project: 'SoftwareAgents',
        claimsDb: 'claims.sqlite',
        progressDb: 'progress.sqlite',
        decisionsFile: 'decisions.json',
        meetingsDir: 'meetings',
        items: [{ id: 'SA-004', clickupId: 'task-4', title: 'Board tests', phase: 'READY' }],
      }),
    );
  }

  function seedDatabases(state = 'active', heartbeat = nowS): void {
    const claims = new DatabaseSync!(path.join(commonDir, 'claims.sqlite'));
    try {
      claims.exec(`CREATE TABLE claims (
        task_id TEXT, worker TEXT, session TEXT, worktree TEXT, state TEXT, heartbeat_at REAL
      )`);
      claims
        .prepare('INSERT INTO claims VALUES (?, ?, ?, ?, ?, ?)')
        .run('task-4', 'codex', 'session-4', path.join(root, 'SA-004'), state, heartbeat);
    } finally {
      claims.close();
    }
    const progress = new DatabaseSync!(path.join(commonDir, 'progress.sqlite'));
    try {
      progress.exec(`CREATE TABLE progress (
        id INTEGER, at REAL, session TEXT, phase TEXT, state TEXT, detail TEXT, task TEXT, provider TEXT
      )`);
      const insert = progress.prepare('INSERT INTO progress VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      insert.run(1, nowS - 10, 'session-4', 'IMPLEMENT', 'START', 'Older event', 'task-4', 'codex');
      insert.run(2, nowS, 'session-4', 'IMPLEMENT', 'DONE', 'Tests added', 'SA-004', 'codex');
    } finally {
      progress.close();
    }
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-watcher-'));
    workspace = path.join(root, 'workspace');
    commonDir = path.join(root, 'git-common');
    fs.mkdirSync(path.join(workspace, 'docs', 'backlog'), { recursive: true });
    fs.mkdirSync(commonDir);
    boardFile = path.join(workspace, 'docs', 'backlog', 'board.json');
    writeBoard();
    vi.mocked(childProcess.execFileSync).mockReturnValue(commonDir);
    store = new AgentStateStore();
    watcher = new BoardWatcher(store, workspace, () => nowS * 1000);
    watcher.start();
    watcher.dispose();
  });

  afterEach(() => {
    watcher.dispose();
    store.dispose();
    vi.clearAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['broken YAML', 'brain: [', '/project.yaml'],
    ['invalid schema', '{}', '/apiVersion'],
    [
      'escaping path',
      JSON.stringify({
        apiVersion: 'softwareagents.io/v1alpha1',
        kind: 'Project',
        id: 'sample',
        name: 'Sample',
        repo: { remote: 'https://example.com/sample.git', defaultBranch: 'main' },
        brain: { path: '../outside' },
      }),
      '/brain/path',
    ],
  ])('disables the board for %s without writes', (_name, manifest, field) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.mkdirSync(path.join(workspace, '.softwareagents'));
    fs.writeFileSync(path.join(workspace, '.softwareagents/project.yaml'), manifest);
    const write = vi.spyOn(fs, 'writeFileSync');
    const send = vi.spyOn(store, 'broadcast');
    const invalidWatcher = new BoardWatcher(store, workspace);
    try {
      expect(() => invalidWatcher.start()).not.toThrow();
      expect(invalidWatcher.build()).toMatchObject({
        mode: 'invalid',
        sources: { board: false },
        items: [],
      });
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ mode: 'invalid' }));
      expect(write).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining(field));
    } finally {
      invalidWatcher.dispose();
      write.mockRestore();
      log.mockRestore();
    }
  });

  function bindBoard(boardPath: string | null = 'custom/board.json'): void {
    fs.mkdirSync(path.join(workspace, '.softwareagents'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.softwareagents/project.yaml'),
      JSON.stringify({
        apiVersion: 'softwareagents.io/v1alpha1',
        kind: 'Project',
        id: 'sample',
        name: 'Sample',
        repo: { remote: 'https://example.com/sample.git', defaultBranch: 'main' },
        brain: { path: '.softwareagents/brain' },
        clickup: { workspaceId: '123', folderId: '456', listIds: [] },
        ...(boardPath ? { legacy: { boardFile: boardPath } } : {}),
      }),
    );
  }

  it('uses registry runs for a bound project and retains the legacy source', () => {
    const board = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
    board.runsDir = 'legacy-runs';
    fs.writeFileSync(boardFile, JSON.stringify(board));
    watcher.build();
    expect(claudeQuota).toHaveBeenLastCalledWith(path.join(commonDir, 'legacy-runs'), nowS);
    bindBoard('docs/backlog/board.json');
    const bound = new BoardWatcher(store, workspace, () => nowS * 1000);
    bound.start();
    bound.dispose();
    expect(claudeQuota).toHaveBeenLastCalledWith(
      path.join(commonDir, 'softwareagents', 'runs'),
      nowS,
    );
  });
  it('reads the bound board and keeps task ids opaque', () => {
    bindBoard();
    fs.mkdirSync(path.join(workspace, 'custom'));
    fs.writeFileSync(
      path.join(workspace, 'custom/board.json'),
      JSON.stringify({
        decisionsFile: 'custom/decisions.json',
        items: [{ id: 'opaque_task', title: 'Bound task' }],
      }),
    );
    fs.writeFileSync(
      path.join(workspace, 'custom/decisions.json'),
      JSON.stringify({
        decisions: [{ id: 'choice', status: 'open', options: ['yes'] }],
      }),
    );
    const bound = new BoardWatcher(store, workspace);
    expect(bound.build()?.items.map((item) => item.id)).toEqual(['opaque_task']);
    expect(bound.build()?.decisions?.map((decision) => decision.id)).toEqual(['choice']);
  });

  it('does not use the default board for a manifest without a legacy binding', () => {
    bindBoard(null);
    const bound = new BoardWatcher(store, workspace, () => nowS * 1000);
    bound.start();
    bound.dispose();
    expect(bound.build()).toMatchObject({
      mode: 'project',
      project: 'Sample',
      projectId: 'sample',
      clickupFolderUrl: 'https://app.clickup.com/123/v/f/456',
      sources: { board: false },
      items: [],
    });
    expect(claudeQuota).toHaveBeenLastCalledWith(
      path.join(commonDir, 'softwareagents', 'runs'),
      nowS,
    );
  });

  it('broadcasts provider capacity without a board and retains it for late clients', async () => {
    bindBoard(null);
    const quota = (provider: 'claude' | 'codex') => ({
      provider,
      status: 'warning' as const,
      usedPercent: 95,
      resetsAt: nowS + 60,
      observedAt: nowS,
      capacity: {
        provider,
        status: 'warning' as const,
        observedAt: nowS,
        source: 'estimated' as const,
        confidence: 'low' as const,
        windows: [],
      },
    });
    vi.mocked(claudeQuota).mockReturnValueOnce(quota('claude'));
    vi.mocked(codexQuota).mockReturnValueOnce(quota('codex'));
    const send = vi.spyOn(store, 'broadcast');
    const bound = new BoardWatcher(store, workspace, () => nowS * 1000);
    bound.start();
    bound.dispose();
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sources: { board: false, claims: false, progress: false },
        quota: { claude: quota('claude'), codex: quota('codex') },
      }),
    );
    const { latestBoardMessage } = await import('../src/boardWatcher.js');
    expect(latestBoardMessage()?.quota.claude.capacity?.status).toBe('warning');
  });

  it.skipIf(!DatabaseSync)('reads claims and progress from the bound board', () => {
    bindBoard('custom/board.json');
    fs.mkdirSync(path.join(workspace, 'custom'));
    fs.copyFileSync(boardFile, path.join(workspace, 'custom/board.json'));
    fs.unlinkSync(boardFile);
    seedDatabases();
    const bound = new BoardWatcher(store, workspace, () => nowS * 1000);
    bound.start();
    bound.dispose();
    expect(bound.build()?.sources).toEqual({ board: true, claims: true, progress: true });
    expect(bound.build()?.items[0].owner?.session).toBe('session-4');
    expect(bound.build()?.items[0].lastEvent?.detail).toBe('Tests added');
  });

  it('revalidates the bound board when a directory is replaced by a link', () => {
    bindBoard('custom/board.json');
    fs.mkdirSync(path.join(workspace, 'custom'));
    const bound = new BoardWatcher(store, workspace);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'board.json'), JSON.stringify({ items: [] }));
    fs.rmdirSync(path.join(workspace, 'custom'));
    const link = path.join(workspace, 'custom');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(bound.build()).toMatchObject({ sources: { board: false }, items: [] });
    } finally {
      fs.unlinkSync(link);
    }
  });

  it('rejects escaping paths declared by the bound board', () => {
    bindBoard('docs/backlog/board.json');
    fs.writeFileSync(
      boardFile,
      JSON.stringify({
        claimsDb: '../claims.sqlite',
        progressDb: '../progress.sqlite',
        decisionsFile: '../decisions.json',
        items: [],
      }),
    );
    const bound = new BoardWatcher(store, workspace);
    bound.start();
    bound.dispose();
    expect(bound.build()?.sources).toEqual({ board: true, claims: false, progress: false });
    expect(bound.build()?.decisions).toEqual([]);
  });

  it.skipIf(!DatabaseSync).each([
    ['active', 'ACTIVE'],
    ['awaiting_review', 'AWAITING_REVIEW'],
    ['completed', 'DONE'],
  ])('lets a %s claim override the board phase', (state, phase) => {
    seedDatabases(state);
    expect(watcher.build()).toMatchObject({
      sources: { board: true, claims: true, progress: true },
      items: [
        {
          phase,
          owner: { worker: 'codex', state, stale: false, worktree: 'SA-004' },
          lastEvent: { at: nowS * 1000, task: 'SA-004', detail: 'Tests added', provider: 'codex' },
        },
      ],
      recent: [{ detail: 'Tests added' }, { detail: 'Older event' }],
    });
  });

  it.skipIf(!DatabaseSync)('preserves VERIFIED while a claim awaits review', () => {
    seedDatabases('awaiting_review');
    const board = JSON.parse(fs.readFileSync(boardFile, 'utf-8'));
    board.items[0].phase = 'VERIFIED';
    fs.writeFileSync(boardFile, JSON.stringify(board));
    expect(watcher.build()).toMatchObject({ items: [{ phase: 'VERIFIED' }] });
  });

  it.skipIf(!DatabaseSync).each([
    ['active', 1800, false],
    ['active', 1801, true],
    ['awaiting_review', 1801, false],
    ['completed', 1801, false],
  ])('marks %s with a %s-second-old heartbeat stale: %s', (state, age, stale) => {
    seedDatabases(state, nowS - age);
    expect(watcher.build()).toMatchObject({ items: [{ owner: { state, stale } }] });
  });

  it('includes only open and answered decisions', () => {
    const decisions = ['open', 'answered', 'closed', 'cancelled', undefined].map((status, id) => ({
      id,
      status,
    }));
    fs.writeFileSync(path.join(workspace, 'decisions.json'), JSON.stringify({ decisions }));
    expect(watcher.build()?.decisions).toEqual(decisions.slice(0, 2));
  });

  it.each([7199, 7201])('shows only a recent meeting and its last 12 lines (age %s)', (age) => {
    const dir = path.join(commonDir, 'meetings', 'meeting-1');
    fs.mkdirSync(dir, { recursive: true });
    const meeting = { id: 'meeting-1', endedAt: nowS - age };
    fs.writeFileSync(path.join(dir, 'meeting.json'), JSON.stringify(meeting));
    const lines = Array.from({ length: 15 }, (_, index) => ({
      at: index,
      speaker: 'codex',
      text: `Private transcript ${index}`,
      summary: `Summary ${index}`,
    }));
    fs.writeFileSync(
      path.join(dir, 'transcript.jsonl'),
      lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
    );
    expect(watcher.build()?.meeting).toEqual(
      age > 7200
        ? undefined
        : {
            ...meeting,
            lines: lines.slice(-12).map(({ text: _text, ...rest }) => rest),
          },
    );
  });

  it('leaves missing sources empty and retains only the board data', () => {
    expect(watcher.build()).toMatchObject({
      sources: { board: true, claims: false, progress: false },
      items: [
        { id: 'SA-004', phase: 'READY', owner: undefined, lastEvent: undefined, agentIds: [] },
      ],
      manager: undefined,
      recent: [],
      gate: [],
      waiting: [],
      decisions: [],
      meeting: undefined,
    });
    expect(fs.readdirSync(commonDir)).toEqual([]);
  });

  it.skipIf(!DatabaseSync).each(['claims.sqlite', 'progress.sqlite'])(
    'keeps the other SQLite source when %s is missing',
    (missing) => {
      seedDatabases();
      fs.unlinkSync(path.join(commonDir, missing));
      const message = watcher.build();
      expect(message?.sources).toEqual({
        board: true,
        claims: missing !== 'claims.sqlite',
        progress: missing !== 'progress.sqlite',
      });
      if (missing === 'claims.sqlite') {
        expect(message).toMatchObject({
          items: [{ phase: 'READY', owner: undefined, lastEvent: { detail: 'Tests added' } }],
          recent: [{ detail: 'Tests added' }, { detail: 'Older event' }],
        });
      } else {
        expect(message).toMatchObject({
          items: [{ phase: 'ACTIVE', owner: { worker: 'codex' }, lastEvent: undefined }],
          recent: [],
          gate: [],
          waiting: [],
        });
      }
    },
  );

  it('keeps meeting metadata with empty lines when its transcript is missing', () => {
    const dir = path.join(commonDir, 'meetings', 'meeting-1');
    fs.mkdirSync(dir, { recursive: true });
    const meeting = { id: 'meeting-1', endedAt: nowS - 60 };
    fs.writeFileSync(path.join(dir, 'meeting.json'), JSON.stringify(meeting));
    expect(watcher.build()?.meeting).toEqual({ ...meeting, lines: [] });
  });

  it('returns no board when board.json is missing', () => {
    fs.unlinkSync(boardFile);
    expect(watcher.build()).toMatchObject({ mode: 'legacy', sources: { board: false }, items: [] });
  });
});
