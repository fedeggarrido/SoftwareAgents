import { useSyncExternalStore } from 'react';

// ── Company backlog (server `boardState`) ────────────────────────────────────
// The server sends the whole board each time something visible changes, and
// once more to a client that connects late. Nothing here is derived: the
// panel renders exactly what the company's own files and databases said.

export interface BoardEvent {
  at: number;
  session: string;
  phase: string;
  state: string;
  detail: string;
  task?: string;
  provider?: string;
}

export interface BoardOwner {
  worker: string;
  session: string;
  state: string;
  stale: boolean;
  heartbeatAt: number;
  worktree?: string;
}

export interface BoardItem {
  id: string;
  clickupId?: string;
  title: string;
  epic?: string;
  priority?: string;
  size?: string;
  dependsOn?: string[];
  implementer?: string;
  phase: string;
  note?: string;
  owner?: BoardOwner;
  lastEvent?: BoardEvent;
  agentIds: number[];
}

export interface ProviderQuota {
  provider: 'claude' | 'codex';
  status: 'allowed' | 'warning' | 'rejected' | 'reset' | 'unknown';
  usedPercent: number | null;
  resetsAt: number | null;
  observedAt: number | null;
  weekly?: { usedPercent: number | null; resetsAt: number | null; windowMinutes?: number };
}

export interface CompanyDecision {
  id: string;
  question: string;
  context?: string;
  options: string[];
  recommendation?: string;
  blocks?: string[];
  status: string;
  answer?: string | null;
}

export interface MeetingLine {
  at: number;
  round: string;
  role: string;
  stance: string;
}

export interface MeetingState {
  id: string;
  format: string;
  topic: string;
  question: string;
  participants: string[];
  status: string;
  round: string;
  decision?: string | null;
  waitReason?: string;
  task?: string;
  lines: MeetingLine[];
}

export interface AutopilotState {
  enabled: boolean;
  running: boolean;
  status?: string;
  waitReason?: string;
  nextRound?: number | null;
  lastRound?: number;
  intervalMinutes?: number;
}

export interface BoardState {
  project: string;
  items: BoardItem[];
  manager?: BoardOwner;
  recent: BoardEvent[];
  sources: { board: boolean; claims: boolean; progress: boolean };
  quota?: { claude: ProviderQuota; codex: ProviderQuota };
  gate?: BoardEvent[];
  summary?: {
    total: number;
    byPhase: Record<string, number>;
    byEpic: Record<string, { done: number; total: number }>;
  };
  waiting?: BoardEvent[];
  decisions?: CompanyDecision[];
  meeting?: MeetingState;
  autopilot?: AutopilotState;
  generatedAt: number;
}

let board: BoardState | null = null;
const listeners = new Set<() => void>();

export function setBoardState(next: BoardState): void {
  board = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBoard(): BoardState | null {
  return useSyncExternalStore(subscribe, () => board);
}

// ── Short notices from the company controls (autopilot, decisions) ──
let notice: { text: string; at: number } | null = null;
const noticeListeners = new Set<() => void>();

export function setCompanyNotice(text: string): void {
  notice = { text, at: Date.now() };
  for (const l of noticeListeners) l();
}

export function useCompanyNotice(): { text: string; at: number } | null {
  return useSyncExternalStore(
    (l) => {
      noticeListeners.add(l);
      return () => noticeListeners.delete(l);
    },
    () => notice,
  );
}
