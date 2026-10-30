import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { HumanDecision } from '../../core/src/humanDecision.js';
import type {
  AutopilotState,
  BoardDecision,
  BoardEvent,
  BoardState,
  MeetingState,
} from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { type BoardSelection, BoardSources, loadBoardSelection } from './boardSources.js';
import { readAutopilot } from './companyControl.js';
import { BOARD_RECENT_EVENTS } from './constants.js';
import { claudeQuota, codexQuota } from './quotaReader.js';
import { readRows } from './sqliteReadOnly.js';
import { type WorkStoreBoard, WorkStoreBoardSource } from './workStoreBoardSource.js';

/**
 * The agent company's backlog, as the office shows it: which task is in which
 * phase, who holds it and what was last reported about it.
 *
 * Three local sources, all written by the company's own tooling, never guessed:
 *  - `docs/backlog/board.json` in the workspace: the manager's mirror of each
 *    task's phase (ANALYSIS, READY, ...) plus its title/epic/priority.
 *  - the task-claims SQLite in the Git common dir: who holds a task right now
 *    (active / awaiting_review / completed). A claim outranks the board's phase:
 *    it is the ownership record workers and manager actually write.
 *  - the progress SQLite next to it: the last event each task/session reported.
 *
 * Read-only. A missing or unreadable source leaves that part empty rather than
 * inventing a state; the board message says which sources were read.
 */

export interface BoardItem {
  id: string;
  clickupId?: string;
  title: string;
  epic?: string;
  priority?: string;
  size?: string;
  dependsOn?: string[];
  implementer?: string;
  phase?: string;
  note?: string;
}

interface BoardFile {
  project?: string;
  claimsDb?: string;
  progressDb?: string;
  /** Headless run logs (Claude stream-json) under the Git common dir. */
  runsDir?: string;
  /** Owner decisions inbox, relative to the workspace. */
  decisionsFile?: string;
  /** Meeting transcripts under the Git common dir. */
  meetingsDir?: string;
  items?: BoardItem[];
}

/** The newest meeting (running, or ended less than two hours ago) with its last lines. */
function latestMeeting(dir: string | undefined, nowS: number): MeetingState | undefined {
  if (!dir) return undefined;
  let best: { path: string; mtime: number } | undefined;
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name, 'meeting.json');
      try {
        const mtime = fs.statSync(file).mtimeMs;
        if (!best || mtime > best.mtime) best = { path: path.join(dir, name), mtime };
      } catch {
        /* not a meeting */
      }
    }
  } catch {
    return undefined;
  }
  if (!best) return undefined;
  try {
    const meeting = JSON.parse(
      fs.readFileSync(path.join(best.path, 'meeting.json'), 'utf-8'),
    ) as Record<string, unknown>;
    const ended = typeof meeting.endedAt === 'number' ? meeting.endedAt : null;
    if (ended !== null && nowS - ended > 2 * 3600) return undefined;
    let lines: MeetingState['lines'] = [];
    try {
      lines = fs
        .readFileSync(path.join(best.path, 'transcript.jsonl'), 'utf-8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .map(({ text: _text, ...rest }) => rest as unknown as MeetingState['lines'][number]);
    } catch {
      /* no lines yet */
    }
    return { ...meeting, lines: lines.slice(-12) } as unknown as MeetingState;
  } catch {
    return undefined;
  }
}

function openDecisions(file: string): BoardDecision[] {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      decisions?: BoardDecision[];
    };
    return (data.decisions ?? []).filter((d) => d.status === 'open' || d.status === 'answered');
  } catch {
    return [];
  }
}

interface ClaimRow {
  task_id: string;
  worker: string;
  session: string;
  worktree: string;
  state: string;
  heartbeat_at: number;
}

interface ProgressRow {
  id: number;
  at: number;
  session: string;
  phase: string;
  state: string;
  detail: string;
  task: string;
  provider?: string;
}

const CLAIM_PHASE: Record<string, string> = {
  active: 'ACTIVE',
  awaiting_review: 'AWAITING_REVIEW',
  completed: 'DONE',
};

/** A claim whose heartbeat is older than this is shown as stale (never released). */
const STALE_AFTER_S = 1800;
const POLL_MS = 3000;

let latest: BoardState | undefined;

/** The last board sent, for a client that connects later. */
export function latestBoardMessage(): BoardState | undefined {
  return latest;
}

/** The Git common dir shared by every worktree of the workspace, where WorkStore lives. */
export function gitCommonDir(workspace: string): string | undefined {
  try {
    const out = execFileSync(
      'git',
      ['-C', workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

function eventView(e: ProgressRow): BoardEvent {
  return {
    at: Math.round(e.at * 1000),
    session: e.session,
    phase: e.phase,
    state: e.state,
    detail: e.detail,
    task: e.task,
    provider: e.provider || undefined,
  };
}

export class BoardWatcher {
  private timer: NodeJS.Timeout | undefined;
  private lastSent = '';
  private commonDir: string | undefined;
  private readonly sources: BoardSources;
  private readonly workStoreSource = new WorkStoreBoardSource();
  private workBoard: WorkStoreBoard | null = null;
  private generation = 0;

  constructor(
    private readonly store: AgentStateStore,
    private readonly workspaceDir: string,
    private readonly now: () => number = Date.now,
    selection?: BoardSelection,
  ) {
    this.sources = new BoardSources(workspaceDir, selection ?? loadBoardSelection(workspaceDir));
  }

  start(): void {
    this.commonDir = gitCommonDir(this.workspaceDir);
    this.tick();
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.generation++;
    this.workStoreSource.dispose();
  }

  /** Build the board; broadcast it only when something visible changed. */
  async tick(): Promise<void> {
    const selection = this.sources.selection;
    if (selection.kind === 'project') {
      const file = this.sources.source(this.commonDir, 'softwareagents/work.sqlite3');
      const generation = this.generation;
      if (file && fs.existsSync(file)) {
        const safe = ['-wal', '-shm', '-journal'].every((suffix) =>
          this.sources.source(this.commonDir, `softwareagents/work.sqlite3${suffix}`),
        );
        this.workBoard = safe
          ? await this.workStoreSource.read(file, selection.project.project.id, this.now())
          : { items: [], recent: [], decisions: [], readable: false };
      } else this.workBoard = null;
      if (generation !== this.generation) return;
    }
    const message = this.build();
    if (!message) return;
    const { generatedAt: _ignored, ...visible } = message;
    const key = JSON.stringify(visible);
    latest = message;
    if (key === this.lastSent) return;
    this.lastSent = key;
    this.store.broadcast({ ...message });
  }

  build(): BoardState | undefined {
    if (this.workBoard) return this.buildWorkStoreBoard(this.workBoard);
    let board: BoardFile = {};
    let hasBoard = false;
    try {
      const boardPath = this.sources.boardFile();
      if (boardPath) {
        const parsed = JSON.parse(fs.readFileSync(boardPath, 'utf-8')) as BoardFile;
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed) ||
          (parsed.items !== undefined && !Array.isArray(parsed.items))
        )
          throw new Error('Invalid board');
        board = parsed;
        hasBoard = true;
      }
    } catch {
      // Capacity remains observable even without a readable board.
    }
    const selection = this.sources.selection;
    const project = selection.kind === 'project' ? selection.project.project : undefined;
    const items = board.items ?? [];
    const dir = this.commonDir;
    const claimsFile = this.sources.source(dir, board.claimsDb);
    const claims = claimsFile
      ? readRows<ClaimRow>(
          claimsFile,
          'SELECT task_id, worker, session, worktree, state, heartbeat_at FROM claims',
        )
      : undefined;
    const progressFile = this.sources.source(dir, board.progressDb);
    const events = progressFile
      ? readRows<ProgressRow>(progressFile, 'SELECT * FROM progress ORDER BY id DESC LIMIT 400')
      : undefined;

    const claimByTask = new Map((claims ?? []).map((c) => [c.task_id, c]));
    const nowS = this.now() / 1000;
    const ownerOf = (c: ClaimRow) => ({
      worker: c.worker,
      session: c.session,
      state: c.state,
      stale: c.state === 'active' && nowS - c.heartbeat_at > STALE_AFTER_S,
      heartbeatAt: Math.round(c.heartbeat_at * 1000),
      worktree: c.worktree ? path.basename(c.worktree) : undefined,
    });

    // Who is on each task, from the roles the office already resolved.
    const agentsByKey = new Map<string, number[]>();
    for (const [id, agent] of this.store) {
      const detail = agent.role?.detail;
      if (!detail) continue;
      for (const token of detail.split(/\s+/)) {
        const list = agentsByKey.get(token) ?? [];
        list.push(id);
        agentsByKey.set(token, list);
      }
    }

    const view = items.map((item) => {
      const claim = item.clickupId ? claimByTask.get(item.clickupId) : undefined;
      const keys = [item.id, item.clickupId].filter((k): k is string => !!k);
      const last = events?.find((e) => keys.includes(e.task));
      const agentIds = [...new Set(keys.flatMap((k) => agentsByKey.get(k) ?? []))];
      return {
        ...item,
        // A claim outranks the board, except that the manager may mark a delivery
        // that passed review VERIFIED while it still awaits integration.
        phase:
          claim?.state === 'awaiting_review' && item.phase === 'VERIFIED'
            ? 'VERIFIED'
            : ((claim && CLAIM_PHASE[claim.state]) ?? item.phase ?? 'ANALYSIS'),
        owner: claim && claim.state !== 'released' ? ownerOf(claim) : undefined,
        lastEvent: last ? eventView(last) : undefined,
        agentIds,
      };
    });

    const manager = claimByTask.get('__manager__');
    // Sessions whose newest quota-gate decision is WAIT and that have not started since.
    const waiting: BoardEvent[] = [];
    const seenSessions = new Set<string>();
    for (const e of events ?? []) {
      if (seenSessions.has(e.session)) continue;
      seenSessions.add(e.session);
      if (
        e.state === 'WAIT' &&
        (e.phase === 'QUOTA' || e.phase === 'MEETING' || e.phase === 'AUTOPILOT')
      ) {
        waiting.push(eventView(e));
      }
    }
    const byPhase: Record<string, number> = {};
    const byEpic: Record<string, { done: number; total: number }> = {};
    for (const it of view) {
      byPhase[it.phase] = (byPhase[it.phase] ?? 0) + 1;
      const epic = it.epic ?? '—';
      byEpic[epic] ??= { done: 0, total: 0 };
      byEpic[epic].total += 1;
      if (it.phase === 'DONE') byEpic[epic].done += 1;
    }
    const decisionDb = project
      ? this.sources.source(dir, 'softwareagents/work.sqlite3')
      : undefined;
    const structured = decisionDb
      ? (
          readRows<{ escalation: string }>(
            decisionDb,
            'SELECT escalation FROM human_decisions WHERE project_id = ? AND escalation IS NOT NULL ORDER BY key',
            project?.id,
          ) ?? []
        ).map((row) => JSON.parse(row.escalation) as HumanDecision)
      : [];
    const decisionsFile = this.sources.source(this.workspaceDir, board.decisionsFile);
    return {
      type: 'boardState',
      project: project?.name ?? board.project ?? path.basename(this.workspaceDir),
      mode: selection.kind,
      projectId: project?.id,
      clickupFolderUrl: project?.clickup
        ? `https://app.clickup.com/${encodeURIComponent(project.clickup.workspaceId)}/v/f/${encodeURIComponent(project.clickup.folderId)}`
        : undefined,
      items: view,
      manager: manager && manager.state === 'active' ? ownerOf(manager) : undefined,
      recent: (events ?? []).slice(0, BOARD_RECENT_EVENTS).map(eventView),
      sources: { board: hasBoard, claims: claims !== undefined, progress: events !== undefined },
      quota: {
        claude: claudeQuota(this.sources.runsDir(dir, board.runsDir), nowS),
        codex: codexQuota(nowS),
      },
      // The launchers' quota gate decisions (phase QUOTA), newest first.
      gate: (events ?? [])
        .filter((e) => e.phase === 'QUOTA')
        .slice(0, 5)
        .map(eventView),
      summary: { total: view.length, byPhase, byEpic },
      waiting,
      decisions: [
        ...structured.map((d) => ({
          ...d,
          question: d.context,
          options: d.options.map((o) => o.id),
          structuredOptions: d.options,
        })),
        ...(decisionsFile
          ? openDecisions(decisionsFile).filter((d) => !structured.some((s) => s.id === d.id))
          : []),
      ],
      meeting: latestMeeting(this.sources.source(dir, board.meetingsDir), nowS),
      autopilot: hasBoard ? (readAutopilot() as AutopilotState | undefined) : undefined,
      generatedAt: this.now(),
    };
  }

  private buildWorkStoreBoard(board: WorkStoreBoard): BoardState {
    const selection = this.sources.selection;
    if (selection.kind !== 'project') throw new Error('WorkStore requires a Project');
    const project = selection.project.project;
    const items = board.items.map((item) => ({
      ...item,
      agentIds: [...this.store]
        .filter(
          ([, agent]) =>
            agent.role?.detail?.split(/\s+/).includes(item.id) ||
            (!!item.owner?.session && agent.sessionId === item.owner.session),
        )
        .map(([id]) => id),
    }));
    const byPhase: Record<string, number> = {};
    const byEpic: BoardState['summary']['byEpic'] = {};
    for (const item of items) {
      byPhase[item.phase] = (byPhase[item.phase] ?? 0) + 1;
      const epic = item.epic ?? '—';
      byEpic[epic] ??= { done: 0, total: 0 };
      byEpic[epic].total++;
      if (item.phase === 'DONE') byEpic[epic].done++;
    }
    return {
      type: 'boardState',
      project: project.name,
      projectId: project.id,
      mode: 'project',
      clickupFolderUrl: project.clickup
        ? `https://app.clickup.com/${encodeURIComponent(project.clickup.workspaceId)}/v/f/${encodeURIComponent(project.clickup.folderId)}`
        : undefined,
      items,
      recent: board.recent,
      sources: { board: board.readable, claims: false, progress: false, workStore: true },
      quota: {
        claude: claudeQuota(this.sources.runsDir(this.commonDir, undefined), this.now() / 1000),
        codex: codexQuota(this.now() / 1000),
      },
      summary: { total: items.length, byPhase, byEpic },
      gate: [],
      waiting: [],
      decisions: board.decisions,
      generatedAt: this.now(),
    };
  }
}
