import type { BoardState, CharacterDetail, ServerMessage } from '../../../core/src/messages.js';
import { AGENT_HISTORY_LIMIT, RELATIVE_SECOND_MS, WORK_TASK_DETAIL_PREFIX } from '../constants.js';
import { knownText } from './displayText.js';
import type { AgentRoleView } from './toolUtils.js';
import { extractToolName } from './toolUtils.js';

export interface AgentHistoryEvent {
  key: string;
  at: number;
  text: string;
}
interface ObservedAgent {
  projectId?: string;
  taskKey?: string;
  role?: string;
  status?: string;
  detailAt?: number;
}

export function taskEventText(status?: string): string | undefined {
  if (status === 'RUNNING' || status === 'ACTIVE') return 'Inició la tarea';
  if (status === 'DONE' || status === 'VERIFIED') return 'Terminó la tarea';
  if (status?.startsWith('FAILED')) return 'Falló la tarea';
  if (status === 'REVIEW' || status === 'AWAITING_REVIEW') return 'Pasó la tarea a revisión';
  if (status === 'QA') return 'Pasó la tarea a QA';
}

/** Webview-only observations. Tool rows may be cleared each turn; this bounded history survives. */
export class AgentHistory {
  private rows = new Map<number, AgentHistoryEvent[]>();
  private agents = new Map<number, ObservedAgent>();

  events(id: number): readonly AgentHistoryEvent[] {
    return this.rows.get(id) ?? [];
  }
  detailAt(id: number): number | undefined {
    return this.agents.get(id)?.detailAt;
  }
  clear(): void {
    this.rows.clear();
    this.agents.clear();
  }
  remove(id: number): void {
    this.rows.delete(id);
    this.agents.delete(id);
  }
  append(id: number, event: AgentHistoryEvent): void {
    const rows = this.rows.get(id) ?? [];
    if (rows.some((row) => row.key === event.key)) return;
    this.rows.set(id, [event, ...rows].sort((a, b) => b.at - a.at).slice(0, AGENT_HISTORY_LIMIT));
  }

  receive(message: ServerMessage, now = Date.now()): void {
    if (message.type === 'agentClosed') this.remove(message.id);
    if (message.type === 'existingAgents') {
      for (const id of this.agents.keys()) if (!message.agents.includes(id)) this.remove(id);
    }
    if (message.type === 'agentCreated') {
      this.remove(message.id);
      this.agents.set(message.id, { projectId: message.projectId });
    }
    if (message.type === 'agentRole') {
      const previous = this.agents.get(message.id);
      const detail = message.characterDetail;
      const taskKey =
        knownText(detail?.taskKey) ??
        (message.detail?.startsWith(WORK_TASK_DETAIL_PREFIX)
          ? knownText(message.detail.slice(WORK_TASK_DETAIL_PREFIX.length))
          : undefined);
      const status = knownText(detail?.taskStatus);
      const text = taskEventText(status);
      // Only transitions observed live have a known time; initial snapshots are not starts.
      if (previous && previous.taskKey === taskKey && previous.status !== status && text && taskKey)
        this.append(message.id, {
          key: `status:${taskKey}:${status}:${now}`,
          at: now,
          text: `${text} ${taskKey}`,
        });
      this.agents.set(message.id, {
        projectId: knownText(detail?.projectId) ?? previous?.projectId,
        taskKey: taskKey ?? previous?.taskKey,
        role: knownText(detail?.role) ?? message.label,
        status,
        detailAt: now,
      });
    }
    if (message.type === 'agentToolStart') {
      const tool = knownText(message.toolName) ?? knownText(extractToolName(message.status));
      if (tool)
        this.append(message.id, { key: `tool:${message.toolId}`, at: now, text: `Usó ${tool}` });
    }
    if (message.type === 'boardState') this.receiveBoard(message);
    if (message.type === 'domainEvent') {
      const event = message.event;
      const matches = [...this.agents].filter(
        ([, agent]) =>
          agent.projectId === event.projectId &&
          agent.taskKey === event.taskKey &&
          (!event.agentRole || agent.role === event.agentRole),
      );
      // A task can have old Developer and Reviewer sessions. Attribute only the newest exact match.
      const id = matches.sort(([a], [b]) => b - a)[0]?.[0];
      const task = knownText(event.taskKey);
      const text =
        taskEventText(event.toStatus) ??
        (event.kind === 'execution.started'
          ? 'Inició la tarea'
          : event.kind === 'execution.finished'
            ? 'Terminó la ejecución de'
            : undefined);
      if (id !== undefined && task && text)
        this.append(id, {
          key: `domain:${event.projectId}:${event.eventId}`,
          at: event.at,
          text: `${text} ${task}`,
        });
    }
  }
  private receiveBoard(board: BoardState): void {
    for (const item of board.items) {
      const task = knownText(item.id);
      const candidates = [...this.agents].filter(
        ([id, agent]) =>
          agent.projectId === board.projectId &&
          (item.agentIds.includes(id) || agent.taskKey === item.id),
      );
      const id = candidates.sort(([a], [b]) => b - a)[0]?.[0];
      if (!task || id === undefined) continue;
      for (const event of [
        ...(item.lastEvent ? [item.lastEvent] : []),
        ...board.recent.filter((row) => row.task === item.id),
      ]) {
        const text = taskEventText(event.phase);
        if (text)
          this.append(id, {
            key: `board:${task}:${event.at}:${event.phase}`,
            at: event.at,
            text: `${text} ${task}`,
          });
      }
    }
  }
}

/** Recorded task keys and board associations are scoped to the character's project. */
export function agentTask(
  id: number,
  role: AgentRoleView | undefined,
  projectId?: string,
  board?: BoardState | null,
) {
  const detail = role?.characterDetail;
  const key =
    knownText(detail?.taskKey) ??
    (role?.detail?.startsWith(WORK_TASK_DETAIL_PREFIX)
      ? knownText(role.detail.slice(WORK_TASK_DETAIL_PREFIX.length))
      : undefined);
  const project = knownText(detail?.projectId) ?? projectId;
  const item =
    board && board.projectId === project
      ? (board.items.find((item) => item.id === key) ??
        board.items.find((item) => item.agentIds.includes(id)))
      : undefined;
  return {
    key: knownText(item?.id) ?? key,
    title: knownText(item?.title) ?? knownText(detail?.taskTitle),
  };
}

export function agentElapsed(
  detail: CharacterDetail | undefined,
  observedAt: number | undefined,
  now: number,
): string | undefined {
  const elapsed = knownText(detail?.elapsed);
  const seconds = elapsed?.match(/^(\d+) s$/);
  return seconds && observedAt !== undefined && detail?.taskStatus === 'RUNNING'
    ? `${Number(seconds[1]) + Math.max(0, Math.floor((now - observedAt) / RELATIVE_SECOND_MS))} s`
    : elapsed;
}
