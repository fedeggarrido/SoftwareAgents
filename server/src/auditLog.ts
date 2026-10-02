import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AUDIT_LOCK_POLL_MS, AUDIT_LOCK_TIMEOUT_MS } from './constants.js';
import type { PolicyDecision } from './policy.js';

const REDACTED = '[REDACTED]';

export interface AuditEntry {
  id: string;
  occurredAt: string;
  projectId: string | null;
  actorType: 'human' | 'agent' | 'system' | 'unknown';
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  policyDecision: PolicyDecision | null;
  riskLevel: 'low' | 'medium' | 'high';
  inputHash: string;
  outcome: { status: string; detail?: string };
  taskKey: string | null;
  executionId: string | null;
}

export type AuditInput = Omit<AuditEntry, 'id' | 'occurredAt' | 'inputHash'> & { input?: unknown };
/** Future WorkStore adapters implement append; worker run (SA-061) supplies its
 * server-owned actor, taskKey, executionId and actual evaluatePolicy result here.
 * Sinks receive only the redacted entry, never the original input. */
export interface AuditSink {
  append(entry: AuditEntry): void;
}
export type AuditReadResult =
  { line: number; corrupt: false; entry: AuditEntry } | { line: number; corrupt: true };

function serverTokens(): string[] {
  const dir = path.join(os.homedir(), '.pixel-agents');
  const files = [path.join(dir, 'server.json')];
  try {
    files.push(
      ...fs
        .readdirSync(path.join(dir, 'servers'))
        .filter((name) => name.endsWith('.json'))
        .map((name) => path.join(dir, 'servers', name)),
    );
  } catch {
    /* Registry absent. */
  }
  const tokens: string[] = [];
  for (const file of files) {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value && typeof value === 'object') {
        for (const key of ['authToken', 'token']) {
          const token = (value as Record<string, unknown>)[key];
          if (typeof token === 'string' && token) tokens.push(token);
        }
      }
    } catch {
      /* Missing or malformed discovery file. */
    }
  }
  return tokens;
}

/** Strip credentials even inside free text and URLs, before hashing or sinks. */
export function redactAudit(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets)
      if (secret) {
        text = text.split(secret).join(REDACTED);
        text = text.split(encodeURIComponent(secret)).join(REDACTED);
      }
    return text
      .replace(/([?&]token=)[^&#\s"']*/gi, `$1${REDACTED}`)
      .replace(
        /(authorization["']?\s*[:=]\s*["']?)(?:bearer\s+|basic\s+)?[^\r\n,;"'}]+/gi,
        `$1${REDACTED}`,
      )
      .replace(/\b(?:pk_|sk[-_]|ghp_|github_pat_)[a-zA-Z0-9_-]+/g, REDACTED);
  }
  if (Array.isArray(value)) return value.map((item) => redactAudit(item, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        String(redactAudit(key, secrets)),
        /token|authorization|password|secret|api.?key|private.?key/i.test(key)
          ? REDACTED
          : redactAudit(item, secrets),
      ]),
    );
  return value;
}

export class AuditLog {
  // Exclusive-create lock coordinates all writers. A crashed owner leaves a
  // lock: timeout fails visibly; an operator must verify no writer is alive
  // before removing it. Age-based stealing could allow two concurrent owners.
  constructor(private readonly sinks: readonly AuditSink[] = []) {}

  file(projectId: string | null): string {
    const name = projectId ?? 'machine';
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name)
    )
      throw new Error('Invalid audit project ID');
    return path.join(os.homedir(), '.pixel-agents', 'audit', `${name}.jsonl`);
  }

  append(input: AuditInput): AuditEntry {
    const secrets = serverTokens();
    // Select fields explicitly: extra properties from callers never become log data.
    const entry = redactAudit(
      {
        id: randomUUID(),
        occurredAt: new Date().toISOString(),
        projectId: input.projectId,
        actorType: input.actorType,
        actorId: input.actorId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        policyDecision: input.policyDecision,
        riskLevel: input.riskLevel,
        inputHash: createHash('sha256')
          .update(JSON.stringify(redactAudit(input.input ?? null, secrets)))
          .digest('hex'),
        outcome: input.outcome,
        taskKey: input.taskKey,
        executionId: input.executionId,
      },
      secrets,
    ) as AuditEntry;
    const file = this.file(entry.projectId);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const lock = `${file}.lock`;
    const deadline = Date.now() + AUDIT_LOCK_TIMEOUT_MS;
    let descriptor: number;
    for (;;) {
      try {
        descriptor = fs.openSync(lock, 'wx', 0o600);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Windows may report access denied while another process's unlink is
        // still pending. Retrying exclusive creation never steals that lock.
        if (
          code !== 'EEXIST' &&
          !(process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES'))
        )
          throw error;
        if (Date.now() >= deadline) throw new Error('Audit lock timeout');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, AUDIT_LOCK_POLL_MS);
      }
    }
    try {
      const fd = fs.openSync(file, 'a+', 0o600);
      try {
        // Preserve a crash-truncated tail as its own corrupt line. Never rewrite it.
        const size = fs.fstatSync(fd).size;
        const last = Buffer.alloc(1);
        if (size && fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 10)
          fs.writeFileSync(fd, '\n');
        fs.writeFileSync(fd, JSON.stringify(entry) + '\n', 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      fs.closeSync(descriptor);
      fs.unlinkSync(lock);
    }
    for (const sink of this.sinks) sink.append(entry);
    return entry;
  }

  read(projectId: string | null): AuditReadResult[] {
    let text: string;
    try {
      text = fs.readFileSync(this.file(projectId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.map((line, index) => {
      try {
        const entry: unknown = JSON.parse(line);
        if (!isAuditEntry(entry)) throw new Error('Invalid entry');
        return { line: index + 1, corrupt: false, entry };
      } catch {
        return { line: index + 1, corrupt: true };
      }
    });
  }
}

function isAuditEntry(value: unknown): value is AuditEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    ['id', 'occurredAt', 'action', 'resourceType', 'inputHash'].every(
      (key) => typeof entry[key] === 'string',
    ) &&
    ['projectId', 'actorId', 'resourceId', 'taskKey', 'executionId'].every(
      (key) => entry[key] === null || typeof entry[key] === 'string',
    ) &&
    ['human', 'agent', 'system', 'unknown'].includes(String(entry.actorType)) &&
    ['low', 'medium', 'high'].includes(String(entry.riskLevel)) &&
    !!entry.outcome &&
    typeof entry.outcome === 'object' &&
    typeof (entry.outcome as Record<string, unknown>).status === 'string' &&
    (entry.policyDecision === null ||
      (!!entry.policyDecision &&
        typeof entry.policyDecision === 'object' &&
        ['allow', 'deny', 'require_human'].includes(
          String((entry.policyDecision as Record<string, unknown>).outcome),
        ) &&
        typeof (entry.policyDecision as Record<string, unknown>).reason === 'string'))
  );
}

/** Runtime integrations degrade visibly without leaking error payloads. Direct
 * append callers can instead fail closed on persistence errors. No tamper proof claim. */
export function recordAudit(
  action: string,
  resourceType: string,
  resourceId: string | null,
  outcome: AuditEntry['outcome'],
  options: Partial<
    Pick<
      AuditInput,
      | 'projectId'
      | 'actorType'
      | 'actorId'
      | 'policyDecision'
      | 'riskLevel'
      | 'taskKey'
      | 'executionId'
      | 'input'
    >
  > = {},
): void {
  try {
    new AuditLog().append({
      projectId: null,
      actorType: 'human',
      actorId: 'operator',
      policyDecision: null,
      riskLevel: 'medium',
      taskKey: null,
      executionId: null,
      ...options,
      action,
      resourceType,
      resourceId,
      outcome,
    });
  } catch {
    console.error('[Pixel Agents] Audit persistence failed');
  }
}
