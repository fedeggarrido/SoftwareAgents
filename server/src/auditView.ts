import { promises as fs } from 'fs';

import { type AuditEntry, AuditLog, isAuditEntry, redactAuditForDisplay } from './auditLog.js';

export interface AuditViewEntry {
  line: number;
  occurredAt: string;
  actorType: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  policyDecision: { outcome: string; reason: string } | null;
  riskLevel: string;
  outcome: {
    status: string;
    reason: string | null;
    detail: string | null;
    tier: string | null;
    executor: string | null;
    model: string | null;
    code: string | null;
  };
  taskKey: string | null;
  executionId: string | null;
}

export interface AuditViewResult {
  status: 'ok' | 'empty' | 'read_error';
  entries: AuditViewEntry[];
  totalValid: number;
  truncated: boolean;
  corruptLines: number[];
  excludedCount: number;
}

// The existing validator does not validate optional outcome fields. Project
// only strings so historical extra objects cannot escape through the view.
function optionalText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function project(entry: AuditEntry, line: number): AuditViewEntry {
  return {
    line,
    occurredAt: entry.occurredAt,
    actorType: entry.actorType,
    actorId: optionalText(entry.actorId),
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: optionalText(entry.resourceId),
    policyDecision: entry.policyDecision
      ? { outcome: entry.policyDecision.outcome, reason: entry.policyDecision.reason }
      : null,
    riskLevel: entry.riskLevel,
    outcome: {
      status: entry.outcome.status,
      reason: optionalText(entry.outcome.reason),
      detail: optionalText(entry.outcome.detail),
      tier: optionalText(entry.outcome.tier),
      executor: optionalText(entry.outcome.executor),
      model: optionalText(entry.outcome.model),
      code: optionalText(entry.outcome.code),
    },
    taskKey: optionalText(entry.taskKey),
    executionId: optionalText(entry.executionId),
  };
}

/** Pure read of a Project log; never opens the machine log or invokes writers. */
export async function readAuditView(projectId: string, limit = 500): Promise<AuditViewResult> {
  const result: AuditViewResult = {
    status: 'empty',
    entries: [],
    totalValid: 0,
    truncated: false,
    corruptLines: [],
    excludedCount: 0,
  };
  let text: string;
  try {
    if (typeof projectId !== 'string') throw new Error('Invalid audit project ID');
    text = await fs.readFile(new AuditLog().file(projectId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.status = 'read_error';
    return result;
  }
  const valid: { line: number; entry: AuditEntry; time: number }[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    result.status = 'ok';
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      result.corruptLines.push(index + 1);
      continue;
    }
    if (!isAuditEntry(entry)) {
      result.corruptLines.push(index + 1);
    } else if (entry.projectId !== projectId) {
      result.excludedCount++;
    } else {
      const time = Date.parse(entry.occurredAt);
      valid.push({ line: index + 1, entry, time: Number.isNaN(time) ? -Infinity : time });
    }
  }
  valid.sort((a, b) => (a.time === b.time ? b.line - a.line : a.time > b.time ? -1 : 1));
  // The public view always caps at 500, even if a caller requests more.
  const count = Number.isFinite(limit) ? Math.max(0, Math.min(500, Math.floor(limit))) : 500;
  result.totalValid = valid.length;
  result.truncated = valid.length > count;
  result.entries = redactAuditForDisplay(
    valid.slice(0, count).map(({ entry, line }) => project(entry, line)),
  ) as AuditViewEntry[];
  return result;
}
