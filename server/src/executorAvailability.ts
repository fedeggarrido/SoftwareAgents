import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ExecutorId } from '../../core/src/executorCatalog.js';
import type { ExecutorToggleResult } from '../../core/src/messages.js';
import type { ProjectOperatorConfig } from '../../core/src/project.js';
import { AuditLog, recordAudit } from './auditLog.js';
import { CliUsageError } from './cliErrors.js';
import {
  canonicalJson,
  parseProjects,
  projectConfigError,
  readConfig,
  readRawConfig,
  withConfigLock,
  writeRawConfigFile,
} from './configPersistence.js';
import { LAYOUT_FILE_DIR } from './constants.js';
import { withMachineAdmission } from './executorSlots.js';
import { operatorRevision } from './executorState.js';
import { evaluatePolicy, type PolicyDecision } from './policy.js';

/**
 * SA-088: the one service that changes which Executors a Project may use.
 *
 * Order (docs/design/executor-toggles.md): privilege → Project binding → policy →
 * machine admission lock (no worker can admit meanwhile) → whole-file config lock →
 * strict re-read + CAS → durable intent marker → audit intent → persist + verify →
 * audit result → clear marker. The marker is the "intent without result" record:
 * while it exists every worker refuses to launch for the Project and the snapshot
 * reports recovery_required, until `pixel-agents executors recover <project>`
 * reconciles disk and audit. A failure never answers applied.
 */

const ACTION = 'change_executor_availability';

export interface AvailabilityRequest {
  projectId: string;
  executorId: ExecutorId;
  enabled: boolean;
  requestId: string;
  expectedRevision: string;
}

export interface AvailabilityContext {
  privileged: boolean;
  /** Project the server is bound to (resolved by the server, never by the client). */
  boundProjectId: string | undefined;
}

export interface AvailabilityOutcome {
  status: ExecutorToggleResult['status'];
  errorCode?: ExecutorToggleResult['errorCode'];
  revision?: string;
}

interface PendingChange {
  requestId: string;
  projectId: string;
  executorId: string;
  before: string[];
  after: string[];
  revisionBefore: string;
  revisionAfter: string;
  startedAt: string;
}

function pendingDir(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, 'executor-availability');
}

export function pendingChangePath(projectId: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectId)) throw new Error('Invalid project id');
  return path.join(pendingDir(), `${projectId}.pending.json`);
}

/** Present (even unreadable) = an availability change has no verified result yet. */
export function hasPendingChange(projectId: string): boolean {
  try {
    fs.lstatSync(pendingChangePath(projectId));
    return true;
  } catch (error) {
    // Anything but a clear ENOENT is treated as pending: fail closed.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function readPending(projectId: string): PendingChange | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(pendingChangePath(projectId), 'utf8')) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const p = value as Record<string, unknown>;
      if (
        typeof p.requestId === 'string' &&
        Array.isArray(p.before) &&
        Array.isArray(p.after) &&
        typeof p.revisionBefore === 'string' &&
        typeof p.revisionAfter === 'string'
      )
        return value as PendingChange;
    }
  } catch {
    /* Unreadable marker: reconciled from disk alone. */
  }
  return undefined;
}

function writePending(change: PendingChange): void {
  fs.mkdirSync(pendingDir(), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(pendingChangePath(change.projectId), 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(change, null, 2), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function clearPending(projectId: string): void {
  fs.unlinkSync(pendingChangePath(projectId));
}

/** Membership change only: order and unknown legacy ids are preserved. */
export function nextAllowlist(current: readonly string[], executorId: string, enabled: boolean) {
  if (enabled) return current.includes(executorId) ? [...current] : [...current, executorId];
  return current.filter((id) => id !== executorId);
}

function auditEntry(
  projectId: string | null,
  executorId: string,
  status: string,
  detail: Record<string, unknown>,
  policyDecision: PolicyDecision | null,
  actorType: 'human' | 'unknown' = 'human',
) {
  return {
    projectId,
    actorType,
    actorId: actorType === 'human' ? 'operator' : null,
    action: ACTION,
    resourceType: 'executor',
    resourceId: executorId,
    policyDecision,
    riskLevel: 'high' as const,
    taskKey: null,
    executionId: null,
    input: detail,
    outcome: { status, detail: JSON.stringify(detail) },
  };
}

/** Rejections are audited best-effort; they change nothing, so a failed audit cannot hide a change. */
function reject(
  errorCode: NonNullable<AvailabilityOutcome['errorCode']>,
  request: AvailabilityRequest,
  auditProjectId: string | null,
  actorType: 'human' | 'unknown',
  policyDecision: PolicyDecision | null = null,
  revision?: string,
): AvailabilityOutcome {
  const entry = auditEntry(
    auditProjectId,
    request.executorId,
    'rejected',
    { requestId: request.requestId, enabled: request.enabled, errorCode },
    policyDecision,
    actorType,
  );
  recordAudit(entry.action, entry.resourceType, entry.resourceId, entry.outcome, entry);
  return { status: 'rejected', errorCode, ...(revision ? { revision } : {}) };
}

export function setExecutorAvailability(
  request: AvailabilityRequest,
  context: AvailabilityContext,
): AvailabilityOutcome {
  // Privilege before anything Project-specific, so unprivileged clients learn nothing.
  if (!context.privileged) return reject('unauthorized', request, null, 'unknown');
  if (!context.boundProjectId || context.boundProjectId !== request.projectId)
    return reject('unknown_project', request, null, 'human');
  const { projectId } = request;
  let result: AvailabilityOutcome | undefined;
  try {
    result = withMachineAdmission(`executor-availability-${randomUUID()}`, () =>
      withConfigLock(() => applyLocked(request, projectId)),
    );
  } catch (error) {
    console.error('[Pixel Agents] Executor availability change failed:', (error as Error).message);
    return hasPendingChange(projectId)
      ? { status: 'failed', errorCode: 'recovery_required' }
      : { status: 'failed', errorCode: 'apply_failed' };
  }
  // Admission busy (a worker is admitting right now): nothing was touched.
  return result ?? { status: 'failed', errorCode: 'apply_failed' };
}

function applyLocked(request: AvailabilityRequest, projectId: string): AvailabilityOutcome {
  if (hasPendingChange(projectId)) return reject('recovery_required', request, projectId, 'human');
  // Strict re-read: an unreadable file is never treated as "no config".
  const raw = readRawConfig();
  const rawProjects = raw?.projects;
  const rawPolicy =
    rawProjects && typeof rawProjects === 'object' && !Array.isArray(rawProjects)
      ? (rawProjects as Record<string, unknown>)[projectId]
      : undefined;
  // A toggle never creates a Project or repairs an invalid policy.
  if (rawPolicy === undefined) return reject('unknown_project', request, projectId, 'human');
  const parsed = parseProjects({ [projectId]: rawPolicy });
  const current = parsed[projectId];
  if (!current || projectConfigError(parsed, projectId))
    return reject('policy_denied', request, projectId, 'human');
  const decision = evaluatePolicy(ACTION, 'human', current.autonomyLevel);
  if (decision.outcome !== 'allow')
    return reject('policy_denied', request, projectId, 'human', decision);
  const revisionBefore = operatorRevision(current);
  if (request.expectedRevision !== revisionBefore)
    return reject('revision_conflict', request, projectId, 'human', decision, revisionBefore);

  const before = [...current.allowedExecutors];
  const after = nextAllowlist(before, request.executorId, request.enabled);
  if (canonicalJson(after) === canonicalJson(before)) {
    const entry = auditEntry(
      projectId,
      request.executorId,
      'unchanged',
      { requestId: request.requestId, enabled: request.enabled, before, after },
      decision,
    );
    recordAudit(entry.action, entry.resourceType, entry.resourceId, entry.outcome, entry);
    return { status: 'unchanged', revision: revisionBefore };
  }
  const nextPolicy: ProjectOperatorConfig = { ...current, allowedExecutors: after };
  const revisionAfter = operatorRevision(nextPolicy);
  const change: PendingChange = {
    requestId: request.requestId,
    projectId,
    executorId: request.executorId,
    before,
    after,
    revisionBefore,
    revisionAfter,
    startedAt: new Date().toISOString(),
  };
  const detail = { requestId: request.requestId, enabled: request.enabled, before, after };

  // 1. Durable intent: from here on, workers for this Project refuse to launch.
  try {
    writePending(change);
  } catch {
    return { status: 'failed', errorCode: 'apply_failed', revision: revisionBefore };
  }
  const audit = new AuditLog();
  // 2. Audit the intent; failing it aborts before the config is touched.
  try {
    const e = auditEntry(projectId, request.executorId, 'intent', detail, decision);
    audit.append(e);
  } catch {
    return releaseOrRecover(projectId, 'audit_failed', revisionBefore);
  }
  // 3. Persist (only allowedExecutors changes; every other key is kept verbatim) and verify.
  let persisted = false;
  try {
    writeRawConfigFile({
      ...raw,
      projects: { ...(rawProjects as Record<string, unknown>), [projectId]: nextPolicy },
    });
    persisted = verifyRevision(projectId) === revisionAfter;
  } catch {
    persisted = false;
  }
  if (!persisted) {
    // Unchanged disk = clean failure; anything else needs reconciliation.
    if (verifyRevision(projectId) !== revisionBefore)
      return { status: 'failed', errorCode: 'recovery_required' };
    try {
      audit.append(auditEntry(projectId, request.executorId, 'failed', detail, decision));
    } catch {
      return { status: 'failed', errorCode: 'recovery_required' };
    }
    return releaseOrRecover(projectId, 'persist_failed', revisionBefore);
  }
  // 4. Audit the result; only then is the change "applied".
  try {
    audit.append(auditEntry(projectId, request.executorId, 'applied', detail, decision));
    clearPending(projectId);
  } catch {
    return { status: 'failed', errorCode: 'recovery_required', revision: revisionAfter };
  }
  return { status: 'applied', revision: revisionAfter };
}

/** The config was not changed: drop the marker, or keep the Project blocked if we cannot. */
function releaseOrRecover(
  projectId: string,
  errorCode: 'audit_failed' | 'persist_failed',
  revision: string,
): AvailabilityOutcome {
  try {
    clearPending(projectId);
  } catch {
    return { status: 'failed', errorCode: 'recovery_required' };
  }
  return { status: 'failed', errorCode, revision };
}

function verifyRevision(projectId: string): string | undefined {
  try {
    const raw = readRawConfig();
    const projects = parseProjects(raw?.projects);
    return projects[projectId] ? operatorRevision(projects[projectId]) : undefined;
  } catch {
    return undefined;
  }
}

export interface RecoveryReport {
  status: 'none' | 'recovered';
  /** Which side of the interrupted change is on disk now. */
  found?: 'before' | 'after' | 'other';
  allowedExecutors?: string[];
}

/**
 * Operator-run reconciliation of an interrupted change (CLI only). It never
 * re-applies or reverts anything: it records in the audit log what the config
 * actually says, then reopens launches. The operator decides any further toggle.
 */
export function recoverExecutorAvailability(projectId: string): RecoveryReport {
  return withConfigLock(() => {
    if (!hasPendingChange(projectId)) return { status: 'none' };
    const pending = readPending(projectId);
    const raw = readRawConfig();
    const projects = parseProjects(raw?.projects);
    const current = projects[projectId];
    const revision = current ? operatorRevision(current) : undefined;
    const found: RecoveryReport['found'] =
      pending && revision === pending.revisionAfter
        ? 'after'
        : pending && revision === pending.revisionBefore
          ? 'before'
          : 'other';
    new AuditLog().append(
      auditEntry(
        projectId,
        pending?.executorId ?? 'unknown',
        'recovered',
        {
          requestId: pending?.requestId ?? null,
          found,
          allowedExecutors: current?.allowedExecutors ?? null,
          markerReadable: !!pending,
        },
        null,
      ),
    );
    clearPending(projectId);
    return { status: 'recovered', found, allowedExecutors: current?.allowedExecutors };
  });
}

/**
 * Worker-side check, called INSIDE machine admission: the toggle holds the same
 * lock while it changes the config, so a run either admitted before the change
 * (an existing Execution, left alone) or sees it here. Selections made from a
 * now-stale policy are dropped rather than launched.
 */
export function executorAuthorityBlock(
  projectId: string,
  operatorAtStart: ProjectOperatorConfig,
): string | undefined {
  if (hasPendingChange(projectId))
    return `Executor availability change for ${projectId} has no verified result; run \`pixel-agents executors recover ${projectId}\``;
  const projects = readConfig().projects;
  const current = projects[projectId];
  if (!current || projectConfigError(projects, projectId))
    return `Operator config for ${projectId} is missing or invalid`;
  if (operatorRevision(current) !== operatorRevision(operatorAtStart))
    return `Operator config for ${projectId} changed since this run started; run it again to use the new policy`;
  return undefined;
}

/** `pixel-agents executors recover <projectId>`: prints what the config holds; exit 0. */
export function runExecutorsCommand(argv: string[], out: (line: string) => void = console.log) {
  if (argv[0] !== 'recover' || argv.length !== 2 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(argv[1]))
    throw new CliUsageError('Usage: pixel-agents executors recover <projectId>');
  const report = recoverExecutorAvailability(argv[1]);
  if (report.status === 'none') {
    out(`No interrupted executor availability change for ${argv[1]}.`);
    return;
  }
  const state =
    report.found === 'after'
      ? 'the change was persisted'
      : report.found === 'before'
        ? 'the change was NOT persisted'
        : 'the config matches neither side of the change; review it';
  out(
    `Recovered ${argv[1]}: ${state}. allowedExecutors = ${JSON.stringify(report.allowedExecutors ?? null)}. Launches are open again.`,
  );
}
