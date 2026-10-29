import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import { buildAgentDiagnostics } from '../src/agentDiagnostics.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { CodexWatcher } from '../src/codexWatcher.js';
import { configureCompanyControl } from '../src/companyControl.js';
import { DismissalTracker } from '../src/dismissalTracker.js';
import {
  adoptExternalSessionFromHook,
  scanExternalDir,
  setDismissalTracker,
} from '../src/fileWatcher.js';
import { sessionProject } from '../src/projectScope.js';
import { claudeProvider } from '../src/providers/index.js';

vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: () => process.env.HOME! };
});

let temp: string;
let repo: string;
let foreign: string;
let store: AgentStateStore;
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-scope-'));
  repo = path.join(temp, 'repo');
  foreign = path.join(temp, 'repo-other');
  fs.mkdirSync(path.join(repo, '.softwareagents'), { recursive: true });
  fs.mkdirSync(foreign);
  fs.writeFileSync(
    path.join(repo, '.softwareagents/project.yaml'),
    stringify({
      apiVersion: 'softwareagents.io/v1alpha1',
      kind: 'Project',
      id: 'sample-project',
      name: 'Sample',
      repo: { remote: 'https://example.com/sample.git', defaultBranch: 'main' },
      brain: { path: '.softwareagents/brain' },
      clickup: { workspaceId: '123', folderId: '456', listIds: ['789'] },
    }),
  );
  configureCompanyControl(repo);
  store = new AgentStateStore();
  setDismissalTracker(new DismissalTracker());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  // Reset the server binding to an existing legacy workspace before removing fixtures.
  configureCompanyControl(process.cwd());
  fs.rmSync(temp, { recursive: true, force: true });
});

it('accepts nested and registered worktrees and rejects sibling prefixes without leaking session data', () => {
  for (const sub of ['.worktrees/task', '.claude/worktrees/task']) {
    const dir = path.join(repo, sub);
    fs.mkdirSync(dir, { recursive: true });
    expect(sessionProject(dir)).toEqual({ allowed: true, projectId: 'sample-project' });
  }
  const registration = path.join(repo, '.git/worktrees/external');
  fs.mkdirSync(registration, { recursive: true });
  fs.writeFileSync(path.join(registration, 'gitdir'), path.join(foreign, '.git'));
  expect(sessionProject(foreign).projectId).toBe('sample-project');
  fs.unlinkSync(path.join(registration, 'gitdir'));
  expect(sessionProject(foreign).allowed).toBe(false);
  expect(console.warn).toHaveBeenLastCalledWith(
    '[SoftwareAgents] Session not adopted: cwd outside bound Project or ownership unavailable',
  );
});

it('rejects hooks from other repos; accepted hooks receive derived projectId in diagnostics', () => {
  const adopt = (cwd: string) =>
    adoptExternalSessionFromHook(
      'session',
      undefined,
      cwd,
      new Set(),
      store.nextAgentId,
      store,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      () => {},
    );
  adopt(foreign);
  expect(store.size).toBe(0);
  const dir = path.join(repo, '.worktrees/task');
  fs.mkdirSync(dir, { recursive: true });
  adopt(dir);
  expect([...store.values()][0].projectId).toBe('sample-project');
  expect(buildAgentDiagnostics(store)[0].projectId).toBe('sample-project');
  const agent = [...store.values()][0];
  agent.projectId = 'client-forgery';
  store.set(agent.id, agent);
  expect(agent.projectId).toBe('sample-project');
});

it('rejects Codex rollouts from other repos and adopts a project worktree', () => {
  const now = Date.now();
  const date = new Date(now);
  const root = path.join(temp, 'sessions');
  const day = path.join(
    root,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  );
  fs.mkdirSync(day, { recursive: true });
  const dir = path.join(repo, '.worktrees/task');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, cwd] of [
    ['foreign', foreign],
    ['local', dir],
  ]) {
    fs.writeFileSync(
      path.join(day, `rollout-${name}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { id: name, cwd } }) + '\n',
    );
  }
  const watcher = new CodexWatcher({
    store,
    workspaceDir: repo,
    sessionsRoot: root,
    now: () => now,
    removeAgent: () => {},
  });
  watcher.tick();
  expect(store.size).toBe(1);
  expect([...store.values()][0].projectId).toBe('sample-project');
  watcher.dispose();
});

it('preserves legacy adoption without a manifest', () => {
  fs.unlinkSync(path.join(repo, '.softwareagents/project.yaml'));
  expect(sessionProject(foreign)).toEqual({ allowed: true });
});

it('watch-all JSONL scanning rejects a foreign cwd before announcing or watching it', () => {
  const transcripts = path.join(temp, 'transcripts');
  fs.mkdirSync(transcripts);
  fs.writeFileSync(
    path.join(transcripts, 'foreign.jsonl'),
    JSON.stringify({ type: 'user', cwd: foreign }) + '\n',
  );
  const watchers = new Map<number, fs.FSWatcher>();
  const polls = new Map<number, ReturnType<typeof setInterval>>();
  const added = vi.fn();
  store.on('agentAdded', added);
  scanExternalDir(
    transcripts,
    new Set(),
    store.nextAgentId,
    store,
    watchers,
    polls,
    new Map(),
    new Map(),
    () => {},
  );
  expect(store.size).toBe(0);
  expect(added).not.toHaveBeenCalled();
  expect(watchers.size).toBe(0);
  expect(polls.size).toBe(0);
});

it('adopts project worktree JSONL and derives membership before the creation event', () => {
  const dir = path.join(repo, '.worktrees/task');
  fs.mkdirSync(dir, { recursive: true });
  const transcripts = path.join(temp, 'transcripts');
  fs.mkdirSync(transcripts);
  fs.writeFileSync(
    path.join(transcripts, 'local.jsonl'),
    JSON.stringify({ type: 'user', cwd: dir }) + '\n',
  );
  const watchers = new Map<number, fs.FSWatcher>();
  const polls = new Map<number, ReturnType<typeof setInterval>>();
  const waits = new Map<number, ReturnType<typeof setTimeout>>();
  const permissions = new Map<number, ReturnType<typeof setTimeout>>();
  const added = vi.fn();
  store.on('agentAdded', added);
  try {
    scanExternalDir(
      transcripts,
      new Set(),
      store.nextAgentId,
      store,
      watchers,
      polls,
      waits,
      permissions,
      () => {},
    );
    expect(store.size).toBe(1);
    expect(added.mock.calls[0][1].projectId).toBe('sample-project');
  } finally {
    for (const watcher of watchers.values()) watcher.close();
    for (const timer of [...polls.values(), ...waits.values(), ...permissions.values()])
      clearTimeout(timer);
  }
});

it('rejects foreign hooks before the runtime can buffer or log foreign session identifiers', () => {
  const runtime = new AgentRuntime(store, claudeProvider);
  runtime.watchAllSessions.current = true;
  const log = vi.spyOn(console, 'log');
  try {
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'foreign-secret',
      cwd: foreign,
      source: 'startup',
    });
    runtime.handleHookEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'foreign-secret',
      cwd: foreign,
    });
    expect(store.size).toBe(0);
    expect(log).not.toHaveBeenCalled();
  } finally {
    runtime.dispose();
  }
});

it('fails closed on missing cwd or malformed binding and cross-checks hook cwd against transcript metadata', () => {
  expect(sessionProject().allowed).toBe(false);
  const transcript = path.join(temp, 'foreign.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ cwd: foreign }) + '\n');
  expect(sessionProject(repo, transcript).allowed).toBe(false);
  fs.writeFileSync(path.join(repo, '.softwareagents/project.yaml'), 'invalid: true');
  expect(sessionProject(repo).allowed).toBe(false);
});
