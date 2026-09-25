import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentStateStore } from './agentStateStore.js';
import { DEFAULT_MAX_CONTEXT_TOKENS } from './constants.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';
import type { AgentState } from './types.js';

/**
 * Codex source for the office.
 *
 * Codex has no hooks API, but every Codex session (interactive `codex`,
 * headless `codex exec`, the desktop app) appends its whole life to a rollout
 * file under ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. This watcher tails
 * the rollout files whose session started in the workspace directory and turns
 * their records into the same webview messages the Claude machinery sends
 * (agentToolStart / agentToolDone / agentToolsClear / agentStatus /
 * agentContextUsage), so a Codex character sits and types like a Claude one.
 *
 * It deliberately runs beside the Claude runtime instead of inside it: the
 * runtime keeps its provider in module-level globals and parses Claude's
 * transcript format, and bending that to a second format would risk the
 * Claude path. Codex agents are never persisted (their restore would go
 * through the Claude transcript parser), they are simply rediscovered.
 *
 * Every Codex character is labeled as Codex (agentProviderLabel) -- the office
 * must never pass a Codex session off as Claude.
 */

const SCAN_INTERVAL_MS = 1000;
/** A rollout touched within this window is a live session worth adopting. */
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
/** A finished session leaves the office after this long without new records. */
const FINISHED_DESPAWN_MS = 3 * 60 * 1000;
/** A session that never reported an end (crash, kill) leaves after this long. */
const SILENT_DESPAWN_MS = 20 * 60 * 1000;
const COMMAND_DISPLAY_MAX_LENGTH = 40;

const READ_COMMANDS = new Set([
  'get-content',
  'gc',
  'cat',
  'type',
  'rg',
  'grep',
  'select-string',
  'sls',
  'ls',
  'dir',
  'get-childitem',
  'gci',
  'head',
  'tail',
  'sed',
  'find',
  'wc',
  'test-path',
]);
const READ_GIT_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse']);

export interface CodexToolView {
  /** Claude-style tool name: picks the reading vs typing animation in the webview. */
  toolName: string;
  /** Text shown over the character. */
  status: string;
}

interface Tracked {
  agentId: number;
  offset: number;
  buffer: string;
  lastDataAt: number;
  finished: boolean;
}

export interface CodexWatcherOptions {
  store: AgentStateStore;
  workspaceDir: string;
  removeAgent: (id: number) => void;
  sessionsRoot?: string;
  now?: () => number;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** Pull the shell command out of a code-mode `exec` call: `tools.exec_command({cmd:"..."})`. */
function extractCommand(input: string): string | null {
  const m = /cmd\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

function describeCommand(cmd: string): CodexToolView {
  const words = cmd.trim().split(/\s+/);
  const first = (words[0] ?? '').toLowerCase();
  const isRead =
    READ_COMMANDS.has(first) ||
    (first === 'git' && READ_GIT_SUBCOMMANDS.has((words[1] ?? '').toLowerCase()));
  if (isRead) {
    const target = words.slice(1).find((w) => !w.startsWith('-'));
    return {
      toolName: 'Read',
      status: target
        ? `Reading ${truncate(path.basename(target.replace(/["']/g, '')), 30)}`
        : 'Reading',
    };
  }
  return { toolName: 'Bash', status: `Running: ${truncate(cmd, COMMAND_DISPLAY_MAX_LENGTH)}` };
}

/** Translate one Codex tool call into what the office shows. Exported for tests. */
export function describeCodexTool(name: string, input: unknown): CodexToolView {
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  if (name === 'apply_patch' || /\*\*\* (Update|Add|Delete) File:/.test(text)) {
    const file = /\*\*\* (?:Update|Add|Delete) File:\s*(.+)/.exec(text)?.[1]?.trim();
    return { toolName: 'Edit', status: file ? `Editing ${path.basename(file)}` : 'Editing files' };
  }
  if (name === 'exec' || name === 'shell' || name === 'exec_command') {
    const cmd = extractCommand(text);
    return cmd ? describeCommand(cmd) : { toolName: 'Bash', status: 'Running code' };
  }
  switch (name) {
    case 'js':
      return { toolName: 'Bash', status: 'Running code' };
    case 'spawn_agent':
      return { toolName: 'Bash', status: 'Starting a helper agent' };
    case 'wait_agent':
    case 'wait':
      return { toolName: 'Read', status: 'Waiting for helper agents' };
    case 'followup_task':
    case 'send_message':
      return { toolName: 'Bash', status: 'Messaging a helper agent' };
    case 'list_agents':
      return { toolName: 'Read', status: 'Checking helper agents' };
    default:
      return { toolName: 'Bash', status: `Using ${name}` };
  }
}

/** Read the first record of a rollout: `{type:"session_meta", payload:{cwd, originator, ...}}`. */
function readSessionMeta(file: string): Record<string, unknown> | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const firstLine = buf.subarray(0, n).toString('utf-8').split('\n')[0];
    const rec = JSON.parse(firstLine) as { type?: string; payload?: Record<string, unknown> };
    return rec.type === 'session_meta' && rec.payload ? rec.payload : null;
  } catch {
    return null; // first line still being written, or not a rollout
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Time of the newest complete record in a rollout, from its own `timestamp`. */
function readLastRecordTime(file: string, size: number): number | null {
  let fd: number | undefined;
  try {
    const len = Math.min(size, 64 * 1024);
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf-8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const at = Date.parse((JSON.parse(lines[i]) as { timestamp?: string }).timestamp ?? '');
        if (Number.isFinite(at)) return at;
      } catch {
        /* partial first line of the window, or a line still being written */
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export class CodexWatcher {
  private readonly store: AgentStateStore;
  private readonly workspaceDir: string;
  private readonly removeAgent: (id: number) => void;
  private readonly sessionsRoot: string;
  private readonly now: () => number;
  private readonly tracked = new Map<string, Tracked>();
  /** Rollouts already judged foreign (other workspace) -- never re-read. */
  private readonly ignored = new Set<string>();
  /** Rollouts whose session left the office -- not re-adopted unless they grow again. */
  private readonly retiredSize = new Map<string, number>();
  /** Last known activity per rollout, keyed by the size it was measured at. */
  private readonly activity = new Map<string, { size: number; at: number }>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: CodexWatcherOptions) {
    this.store = options.store;
    this.workspaceDir = options.workspaceDir;
    this.removeAgent = options.removeAgent;
    this.sessionsRoot = options.sessionsRoot ?? path.join(os.homedir(), '.codex', 'sessions');
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), SCAN_INTERVAL_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One scan: adopt new sessions, feed new records, retire quiet ones. Public for tests. */
  tick(): void {
    for (const file of this.candidateFiles()) {
      if (this.tracked.has(file) || this.ignored.has(file)) continue;
      this.tryAdopt(file);
    }
    for (const [file, t] of this.tracked) {
      this.readNew(file, t);
      const quietFor = this.now() - t.lastDataAt;
      if ((t.finished && quietFor > FINISHED_DESPAWN_MS) || quietFor > SILENT_DESPAWN_MS) {
        this.retire(file, t);
      }
    }
  }

  private dayDirs(): string[] {
    const dirs: string[] = [];
    for (const back of [0, 1]) {
      const d = new Date(this.now() - back * 24 * 60 * 60 * 1000);
      const yyyy = String(d.getFullYear());
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      dirs.push(path.join(this.sessionsRoot, yyyy, mm, dd));
    }
    return dirs;
  }

  private candidateFiles(): string[] {
    const out: string[] = [];
    for (const dir of this.dayDirs()) {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
        const file = path.join(dir, name);
        try {
          const stat = fs.statSync(file);
          if (this.now() - this.lastActivity(file, stat) > ACTIVE_WINDOW_MS) continue;
          const retired = this.retiredSize.get(file);
          if (retired !== undefined && stat.size <= retired) continue;
          out.push(file);
        } catch {
          /* vanished between readdir and stat */
        }
      }
    }
    return out;
  }

  /**
   * When the session last did something. Not the file's mtime alone: on
   * Windows Codex appends to its rollout without the modification time moving
   * (a 40 s session kept the mtime of its first second), so a long session
   * would look dead. A file that grew since the last look is active now; a
   * file seen for the first time is judged by its newest record's timestamp.
   */
  private lastActivity(file: string, stat: fs.Stats): number {
    const known = this.activity.get(file);
    if (known && known.size === stat.size) return known.at;
    const at =
      known && stat.size > known.size
        ? this.now()
        : Math.max(stat.mtimeMs, readLastRecordTime(file, stat.size) ?? 0);
    this.activity.set(file, { size: stat.size, at });
    return at;
  }

  private tryAdopt(file: string): void {
    const meta = readSessionMeta(file);
    if (!meta) return; // retry next tick
    const cwd = typeof meta.cwd === 'string' ? meta.cwd : '';
    if (!cwd || !samePath(cwd, this.workspaceDir)) {
      this.ignored.add(file);
      return;
    }
    this.retiredSize.delete(file);
    const originator = typeof meta.originator === 'string' ? meta.originator : '';
    const label = originator.includes('exec') ? 'Codex (auto)' : 'Codex';
    const sessionId =
      typeof meta.id === 'string' ? meta.id : path.basename(file, '.jsonl').slice(-36);

    const id = this.store.nextAgentId.current++;
    const agent: AgentState = {
      id,
      sessionId,
      terminalRef: undefined,
      isExternal: true,
      projectDir: cwd,
      jsonlFile: file,
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      hookDelivered: true, // keeps the Claude heuristic timers off this agent
      hooksOnly: true,
      providerId: 'codex',
      providerLabel: label,
      lastDataAt: this.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      contextTokens: 0,
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    };
    assignPaletteIfNeeded(agent, this.store);
    const t: Tracked = {
      agentId: id,
      offset: 0,
      buffer: '',
      lastDataAt: this.now(),
      finished: false,
    };
    // Replay the backlog silently into state, then announce the agent with
    // its current picture -- an hour-long session must not flash every past
    // tool call through the office.
    this.readNew(file, t, agent);
    this.tracked.set(file, t);
    this.store.set(id, agent);
    this.store.broadcast({ type: 'agentProviderLabel', id, label });
    for (const [toolId, status] of agent.activeToolStatuses) {
      this.store.broadcast({
        type: 'agentToolStart',
        id,
        toolId,
        status,
        toolName: agent.activeToolNames.get(toolId),
      });
    }
    this.store.broadcast({
      type: 'agentStatus',
      id,
      status: agent.isWaiting ? 'waiting' : 'active',
      awaitingInput: false,
    });
    if (agent.contextTokens > 0) this.broadcastContext(id, agent);
    console.log(`[Pixel Agents] Codex: Agent ${id} - adopted ${path.basename(file)} (${label})`);
  }

  private retire(file: string, t: Tracked): void {
    this.tracked.delete(file);
    try {
      this.retiredSize.set(file, fs.statSync(file).size);
    } catch {
      this.retiredSize.set(file, Number.POSITIVE_INFINITY);
    }
    console.log(`[Pixel Agents] Codex: Agent ${t.agentId} - session quiet, leaving the office`);
    this.removeAgent(t.agentId);
  }

  /** Feed new records. With `replayInto`, the agent is not in the store yet:
   *  records only update its state and nothing is broadcast. */
  private readNew(file: string, t: Tracked, replayInto?: AgentState): void {
    const silent = replayInto !== undefined;
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size <= t.offset) return;
    let chunk: string;
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - t.offset);
      fs.readSync(fd, buf, 0, buf.length, t.offset);
      chunk = buf.toString('utf-8');
    } catch {
      return;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    t.offset = size;
    t.lastDataAt = this.now();
    const lines = (t.buffer + chunk).split('\n');
    t.buffer = lines.pop() ?? '';
    const agent = replayInto ?? this.store.get(t.agentId);
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec: { type?: string; payload?: Record<string, unknown> };
      try {
        rec = JSON.parse(line) as typeof rec;
      } catch {
        continue;
      }
      this.apply(rec, t, agent, silent);
    }
  }

  private apply(
    rec: { type?: string; payload?: Record<string, unknown> },
    t: Tracked,
    agent: AgentState | undefined,
    silent: boolean,
  ): void {
    if (!agent) return;
    const p = rec.payload ?? {};
    const kind = p.type;
    const id = t.agentId;
    const send = (m: Record<string, unknown>) => {
      if (!silent) this.store.broadcast(m);
    };

    if (rec.type === 'response_item' && (kind === 'custom_tool_call' || kind === 'function_call')) {
      const toolId = String(p.call_id ?? p.id ?? `codex-${t.offset}`);
      const view = describeCodexTool(String(p.name ?? ''), p.input ?? p.arguments);
      agent.activeToolIds.add(toolId);
      agent.activeToolStatuses.set(toolId, view.status);
      agent.activeToolNames.set(toolId, view.toolName);
      agent.isWaiting = false;
      agent.hadToolsInTurn = true;
      t.finished = false;
      send({ type: 'agentToolStart', id, toolId, status: view.status, toolName: view.toolName });
      send({ type: 'agentStatus', id, status: 'active' });
      return;
    }
    if (
      rec.type === 'response_item' &&
      (kind === 'custom_tool_call_output' || kind === 'function_call_output')
    ) {
      const toolId = String(p.call_id ?? '');
      if (!agent.activeToolIds.delete(toolId)) return;
      agent.activeToolStatuses.delete(toolId);
      agent.activeToolNames.delete(toolId);
      send({ type: 'agentToolDone', id, toolId });
      return;
    }
    if (rec.type === 'event_msg' && kind === 'task_started') {
      agent.isWaiting = false;
      t.finished = false;
      send({ type: 'agentStatus', id, status: 'active' });
      return;
    }
    if (rec.type === 'event_msg' && (kind === 'task_complete' || kind === 'turn_aborted')) {
      agent.activeToolIds.clear();
      agent.activeToolStatuses.clear();
      agent.activeToolNames.clear();
      agent.isWaiting = true;
      agent.hadToolsInTurn = false;
      t.finished = true;
      send({ type: 'agentToolsClear', id });
      send({ type: 'agentStatus', id, status: 'waiting', awaitingInput: false });
      return;
    }
    if (rec.type === 'event_msg' && kind === 'token_count') {
      const info = p.info as
        | { last_token_usage?: { total_tokens?: number }; model_context_window?: number }
        | null
        | undefined;
      const tokens = info?.last_token_usage?.total_tokens;
      if (typeof tokens === 'number' && tokens > 0) {
        agent.contextTokens = tokens;
        if (typeof info?.model_context_window === 'number' && info.model_context_window > 0) {
          agent.maxContextTokens = Math.max(info.model_context_window, tokens);
        }
        if (!silent) this.broadcastContext(id, agent);
      }
    }
  }

  private broadcastContext(id: number, agent: AgentState): void {
    this.store.broadcast({
      type: 'agentContextUsage',
      id,
      contextTokens: agent.contextTokens,
      maxContextTokens: agent.maxContextTokens,
    });
  }
}
