import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { CodexWatcher, describeCodexTool } from '../src/codexWatcher.js';

const WORKSPACE = path.resolve('/work/nemesis');

function rec(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: '2026-09-26T10:00:00Z', type, payload }) + '\n';
}

function meta(cwd: string, originator = 'codex-tui'): string {
  return rec('session_meta', { id: 'sess-codex-1', cwd, originator });
}

function toolCall(callId: string, input: string): string {
  return rec('response_item', { type: 'custom_tool_call', call_id: callId, name: 'exec', input });
}

function toolOutput(callId: string): string {
  return rec('response_item', { type: 'custom_tool_call_output', call_id: callId, output: [] });
}

describe('describeCodexTool', () => {
  it('shows a read-only shell command as reading', () => {
    const v = describeCodexTool(
      'exec',
      'text(await tools.exec_command({cmd:"Get-Content C:/x/AGENTS.md"}))',
    );
    expect(v).toEqual({ toolName: 'Read', status: 'Reading AGENTS.md' });
  });

  it('shows any other command as running it, truncated', () => {
    const v = describeCodexTool(
      'exec',
      'tools.exec_command({cmd:"python -m pytest tests/unit -q --tb=short --maxfail=1"})',
    );
    expect(v.toolName).toBe('Bash');
    expect(v.status.startsWith('Running: python -m pytest')).toBe(true);
    expect(v.status.length).toBeLessThanOrEqual('Running: '.length + 41);
  });

  it('shows a patch as editing the file it touches', () => {
    const v = describeCodexTool('exec', '*** Begin Patch\n*** Update File: C:/src/board.ts\n@@');
    expect(v).toEqual({ toolName: 'Edit', status: 'Editing board.ts' });
  });

  it('names Codex collaboration tools in plain words', () => {
    expect(describeCodexTool('wait_agent', {}).status).toBe('Waiting for helper agents');
    expect(describeCodexTool('spawn_agent', {}).status).toBe('Starting a helper agent');
  });
});

describe('CodexWatcher', () => {
  let root: string;
  let dayDir: string;
  let store: AgentStateStore;
  let messages: Record<string, unknown>[];
  let removed: number[];
  let now: number;
  let watcher: CodexWatcher;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-watch-'));
    now = new Date(2026, 8, 26, 12, 0, 0).getTime();
    dayDir = path.join(root, '2026', '09', '26');
    fs.mkdirSync(dayDir, { recursive: true });
    store = new AgentStateStore();
    messages = [];
    removed = [];
    store.on('broadcast', (m) => messages.push(m));
    watcher = new CodexWatcher({
      store,
      workspaceDir: WORKSPACE,
      removeAgent: (id) => {
        removed.push(id);
        store.delete(id);
      },
      sessionsRoot: root,
      now: () => now,
    });
  });

  afterEach(() => {
    watcher.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeRollout(name: string, content: string): string {
    const file = path.join(dayDir, name);
    fs.writeFileSync(file, content);
    const t = new Date(now);
    fs.utimesSync(file, t, t);
    return file;
  }

  it('adopts a session of this workspace and labels it as Codex', () => {
    writeRollout('rollout-a.jsonl', meta(WORKSPACE));
    watcher.tick();
    expect(store.size).toBe(1);
    const [id, agent] = [...store][0];
    expect(agent.providerId).toBe('codex');
    expect(messages).toContainEqual({ type: 'agentProviderLabel', id, label: 'Codex' });
  });

  it('labels headless codex exec rounds as automatic', () => {
    writeRollout('rollout-a.jsonl', meta(WORKSPACE, 'codex_exec'));
    watcher.tick();
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'agentProviderLabel', label: 'Codex (auto)' }),
    );
  });

  it('adopts a live session whose file modification time never moved (Windows)', () => {
    const file = writeRollout(
      'rollout-a.jsonl',
      meta(WORKSPACE) +
        JSON.stringify({
          timestamp: new Date(now - 30_000).toISOString(),
          type: 'event_msg',
          payload: { type: 'task_started' },
        }) +
        '\n',
    );
    const stale = new Date(now - 60 * 60 * 1000);
    fs.utimesSync(file, stale, stale);
    watcher.tick();
    expect(store.size).toBe(1);
  });

  it('skips a session whose newest record is old', () => {
    const file = writeRollout(
      'rollout-a.jsonl',
      JSON.stringify({
        timestamp: new Date(now - 60 * 60 * 1000).toISOString(),
        type: 'session_meta',
        payload: { id: 's', cwd: WORKSPACE },
      }) + '\n',
    );
    const stale = new Date(now - 60 * 60 * 1000);
    fs.utimesSync(file, stale, stale);
    watcher.tick();
    expect(store.size).toBe(0);
  });

  it('ignores sessions started in another directory', () => {
    writeRollout('rollout-b.jsonl', meta(path.resolve('/work/other')));
    watcher.tick();
    expect(store.size).toBe(0);
  });

  it('adopts a worker session in a worktree inside the workspace', () => {
    writeRollout('rollout-c.jsonl', meta(path.join(WORKSPACE, '.worktrees', 'ft-12')));
    watcher.tick();
    expect(store.size).toBe(1);
  });

  it('does not mistake a sibling folder with the same prefix for the workspace', () => {
    writeRollout('rollout-d.jsonl', meta(`${WORKSPACE}-old`));
    watcher.tick();
    expect(store.size).toBe(0);
  });

  it('replays the backlog silently and announces only what is still open', () => {
    writeRollout(
      'rollout-a.jsonl',
      meta(WORKSPACE) +
        toolCall('c1', 'tools.exec_command({cmd:"git status"})') +
        toolOutput('c1') +
        toolCall('c2', 'tools.exec_command({cmd:"npm test"})'),
    );
    watcher.tick();
    const starts = messages.filter((m) => m.type === 'agentToolStart');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      toolId: 'c2',
      status: 'Running: npm test',
      toolName: 'Bash',
    });
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'agentStatus', status: 'active' }),
    );
  });

  it('streams new tool calls, their end, and the end of the turn', () => {
    const file = writeRollout('rollout-a.jsonl', meta(WORKSPACE));
    watcher.tick();
    messages.length = 0;
    fs.appendFileSync(file, toolCall('c1', 'tools.exec_command({cmd:"rg foo src"})'));
    watcher.tick();
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'agentToolStart', toolId: 'c1', toolName: 'Read' }),
    );
    fs.appendFileSync(file, toolOutput('c1') + rec('event_msg', { type: 'task_complete' }));
    watcher.tick();
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'agentToolDone', toolId: 'c1' }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'agentStatus', status: 'waiting', awaitingInput: false }),
    );
  });

  it('reports the context gauge from token_count', () => {
    writeRollout(
      'rollout-a.jsonl',
      meta(WORKSPACE) +
        rec('event_msg', {
          type: 'token_count',
          info: { last_token_usage: { total_tokens: 50_000 }, model_context_window: 258_400 },
        }),
    );
    watcher.tick();
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'agentContextUsage',
        contextTokens: 50_000,
        maxContextTokens: 258_400,
      }),
    );
  });

  it('lets a finished session leave the office after a quiet spell, and not come back', () => {
    writeRollout('rollout-a.jsonl', meta(WORKSPACE) + rec('event_msg', { type: 'task_complete' }));
    watcher.tick();
    expect(store.size).toBe(1);
    now += 4 * 60 * 1000;
    watcher.tick();
    expect(removed).toHaveLength(1);
    expect(store.size).toBe(0);
    watcher.tick();
    expect(store.size).toBe(0);
  });

  it('is never persisted, so a restart cannot restore it through the Claude parser', () => {
    let saved: unknown[] = [];
    store.setAdapter({
      saveAgents: (a: unknown[]) => {
        saved = a;
      },
    } as never);
    writeRollout('rollout-a.jsonl', meta(WORKSPACE));
    watcher.tick();
    store.persist();
    expect(saved).toEqual([]);
  });
});
