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

export interface BoardState {
  project: string;
  items: BoardItem[];
  manager?: BoardOwner;
  recent: BoardEvent[];
  sources: { board: boolean; claims: boolean; progress: boolean };
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
