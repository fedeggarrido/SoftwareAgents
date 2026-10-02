import type { BoardState } from '../../../core/src/messages.js';
export type {
  AutopilotState,
  BoardEvent,
  BoardItem,
  BoardOwner,
  BoardState,
  BoardDecision as CompanyDecision,
  MeetingLine,
  MeetingState,
  ProviderQuota,
} from '../../../core/src/messages.js';
import { useSyncExternalStore } from 'react';

// ── Company backlog (server `boardState`) ────────────────────────────────────
// The server sends the whole board each time something visible changes, and
// once more to a client that connects late. Nothing here is derived: the
// panel renders exactly what the company's own files and databases said.

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
