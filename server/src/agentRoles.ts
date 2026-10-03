import * as fs from 'fs';

import type { AgentRole as AgentRoleMessage } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { SessionExecution } from './executors/executionRegistry.js';

/**
 * Who each character is inside an agent "mini company" (NEMESIS, FUNDTRINSIC...):
 * manager, implementer, code reviewer, product analyst...
 *
 * Only from facts the sessions record themselves, never guessed from the
 * activity:
 *  - A Codex specialist's rollout names its role in `session_meta.agent_role`
 *    (e.g. "fundtrinsic-code-reviewer") and a nickname ("Leibniz").
 *  - A session's brief names who it is: the manager brief invokes
 *    `$<project>-company-manager`, the worker brief says "Implementa solo la
 *    tarea ClickUp <id>", a specialist launched by hand starts with
 *    "Actúa como <project>-<role>".
 *  - Anything else is someone working with the owner directly.
 *
 * The brief is only matched, never stored or shown: prompts stay private.
 * Roles are project-agnostic: the `<project>-` prefix is dropped, so the same
 * specialist keeps the same label and color in every project.
 */

export interface AgentRole {
  /** What the character does, in Spanish ("QA Código"). */
  label: string;
  /** Department, used for color and grouping. */
  department: Department;
  /** Extra context shown small: the Codex nickname, the ClickUp task... */
  detail?: string;
}

export type Department =
  'Dirección' | 'Ingeniería' | 'Diseño' | 'Calidad' | 'Análisis' | 'Sesiones';

const SPECIALISTS: Record<string, [string, Department]> = {
  qa: ['QA', 'Calidad'],
  reviewer: ['Reviewer', 'Calidad'],
  developer: ['DEV', 'Ingeniería'],
  'company-manager': ['Manager', 'Dirección'],
  'delivery-lead': ['Delivery', 'Dirección'],
  'implementation-lead': ['Tech Lead', 'Ingeniería'],
  'backend-engineer': ['DEV Backend', 'Ingeniería'],
  'connector-engineer': ['DEV Conectores', 'Ingeniería'],
  'graph-neo4j-engineer': ['DEV Grafos', 'Ingeniería'],
  'data-ingestion-engineer': ['DEV Datos', 'Ingeniería'],
  'financial-engine-engineer': ['DEV Motor', 'Ingeniería'],
  'document-intelligence-engineer': ['DEV IA', 'Ingeniería'],
  'frontend-engineer': ['DEV Frontend', 'Ingeniería'],
  'technical-architect': ['Arquitecto', 'Ingeniería'],
  'reliability-engineer': ['SRE', 'Ingeniería'],
  'devops-engineer': ['DevOps', 'Ingeniería'],
  'product-design-lead': ['Diseño', 'Diseño'],
  'ux-researcher': ['UX', 'Diseño'],
  'testing-engineer': ['QA Tests', 'Calidad'],
  'validation-engineer': ['QA Validación', 'Calidad'],
  'code-reviewer': ['QA Código', 'Calidad'],
  'security-reviewer': ['Seguridad', 'Calidad'],
  'acceptance-reviewer': ['QA', 'Calidad'],
  'product-analyst': ['Analista', 'Análisis'],
  'business-analyst': ['Analista Negocio', 'Análisis'],
  'technical-analyst': ['Analista Técnico', 'Análisis'],
  'research-analyst': ['Investigación', 'Análisis'],
  'accounting-analyst': ['Analista Contable', 'Análisis'],
  'financial-analyst': ['Analista Financiero', 'Análisis'],
  'compliance-analyst': ['Compliance', 'Análisis'],
  'growth-strategist': ['Growth', 'Análisis'],
  'customer-discovery-analyst': ['Discovery', 'Análisis'],
  'strategy-challenger': ['Estrategia', 'Análisis'],
  'docs-keeper': ['Docs', 'Ingeniería'],
  docs: ['Docs', 'Ingeniería'],
};

/** Codex's built-in agent types, for helpers spawned without a project role. */
const CODEX_BUILTINS: Record<string, string> = {
  default: 'Ayudante',
  worker: 'Ayudante DEV',
  explorer: 'Explorador del código',
};

const OWNER_SESSION: AgentRole = { label: 'Dueño', department: 'Sesiones' };

/**
 * "fundtrinsic-code-reviewer" / "nemesis-code-reviewer" / "code-reviewer"
 * -> QA Código. Undefined for unknown names.
 */
export function specialistRole(name: string | undefined, detail?: string): AgentRole | undefined {
  if (!name) return undefined;
  const key = SPECIALISTS[name] ? name : name.replace(/^[a-z0-9]+-/, '');
  const known = SPECIALISTS[key];
  if (known) return { label: known[0], department: known[1], detail };
  return undefined;
}

/** Role from the first thing the session was asked to do. */
export function roleFromBrief(brief: string | undefined, provider: 'claude' | 'codex'): AgentRole {
  const text = brief ?? '';
  const explicit =
    /^(?:Rol|Role):\s*(qa|reviewer)\b/im.exec(text)?.[1]?.toLowerCase() ??
    /(?:Actúa como|Tu rol es)\s+(qa|reviewer)\b/i.exec(text)?.[1]?.toLowerCase();
  if (explicit) return specialistRole(explicit)!;
  const manager =
    /\$[a-z0-9]+-company-manager\b/.test(text) || /Actúa como manager de /i.test(text);
  if (manager) {
    return provider === 'claude'
      ? { label: 'Manager', department: 'Dirección', detail: 'de relevo' }
      : { label: 'Manager', department: 'Dirección' };
  }
  const task = /Implementa solo la tarea ClickUp\s+([A-Za-z0-9_-]+)/.exec(text)?.[1];
  if (task) return { label: 'DEV', department: 'Ingeniería', detail: `tarea ${task}` };
  const named = /(?:Actúa como|\$)\s*([a-z0-9]+-[a-z0-9-]+)/i.exec(text)?.[1];
  // The task a specialist was given, when its brief names one explicitly
  // ("Tarea: FT-OPP-001", or the progress command's "--task FT-OPP-001").
  const meeting = /Reunión:\s*([A-Za-z0-9_-]+)/.exec(text)?.[1];
  const briefTask = /(?:Tarea:|--task)\s+([^\s]+)/
    .exec(text)?.[1]
    ?.replace(/[.,;:)\]\u00bb"']+$/, '')
    .replace(/^\(/, '');
  const specialist = specialistRole(
    named?.toLowerCase(),
    meeting ? `reunión ${meeting}` : briefTask ? `tarea ${briefTask}` : undefined,
  );
  if (specialist) return specialist;
  return OWNER_SESSION;
}

/** Role of a Codex session from its `session_meta` payload and its first brief. */
export function codexRole(meta: Record<string, unknown>, brief: string | undefined): AgentRole {
  if (meta.thread_source === 'subagent') {
    const nickname = typeof meta.agent_nickname === 'string' ? meta.agent_nickname : undefined;
    const roleName = typeof meta.agent_role === 'string' ? meta.agent_role : undefined;
    const specialist = specialistRole(roleName, nickname);
    if (specialist) return specialist;
    const builtin = roleName ? CODEX_BUILTINS[roleName] : undefined;
    return { label: builtin ?? 'Ayudante', department: 'Sesiones', detail: nickname };
  }
  const explicit =
    typeof meta.agent_role === 'string' ? specialistRole(meta.agent_role.toLowerCase()) : undefined;
  if (explicit) return explicit;
  return roleFromBrief(brief, 'codex');
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('\n');
  }
  return '';
}

/**
 * A user message that is the brief, not context the CLI injected first
 * (Codex opens with `<recommended_plugins>`, `<environment_context>`...;
 * Claude with `<command-name>` or caveats).
 */
function isBrief(text: string): boolean {
  const t = text.trim();
  return (
    t.length > 0 &&
    !t.startsWith('<') &&
    !t.startsWith('Caveat:') &&
    // Codex injects the workspace's AGENTS.md as the first user message.
    !t.startsWith('# AGENTS.md instructions')
  );
}

function readHead(file: string, bytes = 256 * 1024): string[] | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf-8').split('\n');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Role of a Claude session from its transcript, or undefined while the brief
 * has not been written yet (the caller retries).
 */
export function claudeRoleFromTranscript(file: string): AgentRole | undefined {
  const lines = readHead(file);
  if (!lines) return undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: {
      type?: string;
      isSidechain?: boolean;
      isMeta?: boolean;
      message?: { content?: unknown };
    };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue; // last line still being written
    }
    if (rec.type !== 'user' || rec.isSidechain || rec.isMeta) continue;
    const text = textOf(rec.message?.content);
    if (!isBrief(text)) continue;
    return roleFromBrief(text, 'claude');
  }
  return undefined;
}

/**
 * Role of a Codex session from its rollout, or undefined while neither the
 * specialist metadata nor the brief is there yet (the caller retries).
 */
export function codexRoleFromRollout(file: string): AgentRole | undefined {
  const lines = readHead(file);
  if (!lines) return undefined;
  let meta: Record<string, unknown> | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: { type?: string; payload?: Record<string, unknown> };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
    }
    const p = rec.payload ?? {};
    if (rec.type === 'session_meta') {
      meta = p;
      if (meta.thread_source === 'subagent') return codexRole(meta, undefined);
      if (typeof meta.agent_role === 'string' && specialistRole(meta.agent_role.toLowerCase()))
        return codexRole(meta, undefined);
      continue;
    }
    if (rec.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const text = textOf(p.content);
      if (isBrief(text)) return codexRole(meta ?? {}, text);
    }
  }
  return undefined;
}

/** A task key comes only from a cwd component beneath .worktrees. */
export function taskFromCwd(cwd: string): string | undefined {
  const key = /(?:^|[\\/])\.worktrees[\\/](SA-\d{3})(?!\d)[^\\/]*(?:[\\/]|$)/i.exec(cwd)?.[1];
  return key?.toUpperCase();
}

/** Read recorded cwd rather than encoded project paths or prompt text. */
export function sessionTask(file: string, provider: string | undefined): string | undefined {
  for (const line of readHead(file) ?? []) {
    try {
      const rec = JSON.parse(line) as {
        type?: string;
        cwd?: unknown;
        isSidechain?: boolean;
        payload?: { cwd?: unknown };
      };
      const cwd =
        provider === 'codex'
          ? rec.type === 'session_meta'
            ? rec.payload?.cwd
            : undefined
          : !rec.isSidechain
            ? rec.cwd
            : undefined;
      if (typeof cwd === 'string') return taskFromCwd(cwd);
    } catch {
      // Partial appends are retried on the next tick.
    }
  }
  return undefined;
}

/** The webview message for a role. The webview colors it by department. */
export function roleMessage(id: number, role: AgentRole): AgentRoleMessage {
  return {
    type: 'agentRole',
    id,
    label: role.label,
    department: role.department,
    detail: role.detail,
  };
}

/**
 * Gives every top-level character its role as soon as its session records one.
 *
 * Polls instead of hooking each creation path: Claude agents are born in half a
 * dozen places (terminal adoption, hooks, external scan, restore...) and the
 * brief may not be on disk yet when they are. Sub-agent and teammate
 * characters are skipped: they already carry the lead's team identity.
 */
export class RoleResolver {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: AgentStateStore,
    private readonly intervalMs = 2000,
    private readonly sessions: () => ReadonlyMap<string, SessionExecution> = () => new Map(),
  ) {}

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): void {
    let sessions: ReadonlyMap<string, SessionExecution>;
    try {
      sessions = this.sessions();
    } catch {
      // Registry availability cannot block observational labels. Retry next tick.
      sessions = new Map();
    }
    for (const [id, agent] of this.store) {
      const recorded = sessions.get(agent.sessionId);
      if (!agent.jsonlFile && !recorded) continue;
      if (agent.spawnToolUseId || agent.leadAgentId !== undefined) continue;
      const base =
        agent.providerId === 'codex'
          ? codexRoleFromRollout(agent.jsonlFile)
          : claudeRoleFromTranscript(agent.jsonlFile);
      const task = sessionTask(agent.jsonlFile, agent.providerId);
      const role: AgentRole | undefined = recorded
        ? {
            ...(specialistRole(recorded.role) ?? { label: recorded.role, department: 'Sesiones' }),
            detail: `tarea ${recorded.taskKey}`,
          }
        : task
          ? {
              ...(base && base.label !== 'Dueño'
                ? base
                : { label: 'DEV', department: 'Ingeniería' }),
              detail: `tarea ${task}`,
            }
          : (base ?? OWNER_SESSION);
      if (
        !role ||
        (agent.role?.label === role.label &&
          agent.role.department === role.department &&
          agent.role.detail === role.detail)
      )
        continue;
      agent.role = role;
      this.store.broadcast({ ...roleMessage(id, role) });
    }
  }
}
