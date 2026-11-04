import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { promisify } from 'node:util';

import type { NewHumanDecision } from '../../core/src/humanDecision.js';
import type { PullRequestStatus } from '../../core/src/messages.js';
import type { BoardSelection } from './boardSources.js';
import {
  GH_FAILED_CONCLUSIONS,
  GH_IGNORED_CONCLUSIONS,
  GH_PR_FIELDS,
  GH_PR_MAX_BUFFER_BYTES,
  GH_PR_TIMEOUT_MS,
  GH_STATUS_FAILURES,
  PR_MAX_CHECKS,
  PR_MAX_STRING_CHARS,
  PR_MAX_TIMESTAMP_CHARS,
  PR_MONITOR_ACTOR,
  PR_POLL_INTERVAL_MS,
} from './constants.js';
import { withoutOperatorToken } from './featureIngress.js';
import { evaluatePolicy } from './policy.js';
import { canonicalPullRequest, validatePrSelector } from './pullRequestBinding.js';
import { compileSchema, validateSchema } from './schemaValidation.js';
import { openWorkStore } from './workstore/SqliteWorkStore.js';
import type { TaskRecord, WorkStore } from './workstore/WorkStore.js';

const execute = promisify(execFile);

interface GhCheck {
  __typename: 'CheckRun' | 'StatusContext';
  name?: string;
  context?: string;
  conclusion?: string | null;
  status?: string;
  state?: string;
}
interface GhPullRequest {
  state: PullRequestStatus['state'];
  isDraft: boolean;
  reviewDecision: PullRequestStatus['reviewDecision'];
  statusCheckRollup: GhCheck[] | null;
  mergedAt: string | null;
  url: string;
  headRefName: string;
}

// Treat CLI output as data. Unknown/malformed output cannot authorize state changes.
const validateGhPullRequest = compileSchema<GhPullRequest>({
  type: 'object',
  required: [
    'state',
    'isDraft',
    'reviewDecision',
    'statusCheckRollup',
    'mergedAt',
    'url',
    'headRefName',
  ],
  properties: {
    state: { enum: ['OPEN', 'CLOSED', 'MERGED'] },
    isDraft: { type: 'boolean' },
    reviewDecision: { enum: ['', 'APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'] },
    mergedAt: { type: ['string', 'null'], maxLength: PR_MAX_TIMESTAMP_CHARS },
    url: { type: 'string', maxLength: PR_MAX_STRING_CHARS },
    headRefName: { type: 'string', minLength: 1, maxLength: PR_MAX_STRING_CHARS },
    statusCheckRollup: {
      type: ['array', 'null'],
      maxItems: PR_MAX_CHECKS,
      items: {
        type: 'object',
        required: ['__typename'],
        properties: {
          __typename: { enum: ['CheckRun', 'StatusContext'] },
          name: { type: 'string', maxLength: PR_MAX_STRING_CHARS },
          context: { type: 'string', maxLength: PR_MAX_STRING_CHARS },
          conclusion: { type: ['string', 'null'], maxLength: PR_MAX_STRING_CHARS },
          status: { type: 'string', maxLength: PR_MAX_STRING_CHARS },
          state: { type: 'string', maxLength: PR_MAX_STRING_CHARS },
        },
      },
    },
  },
});

function checkOutcome(check: GhCheck): PullRequestStatus['ci'] | 'ignored' {
  if (check.__typename === 'StatusContext') {
    if (GH_STATUS_FAILURES.includes(check.state ?? '')) return 'failure';
    return check.state === 'SUCCESS' ? 'success' : 'pending';
  }
  if (GH_FAILED_CONCLUSIONS.includes(check.conclusion ?? '')) return 'failure';
  if (GH_IGNORED_CONCLUSIONS.includes(check.conclusion ?? '')) return 'ignored';
  return check.status === 'COMPLETED' && check.conclusion === 'SUCCESS' ? 'success' : 'pending';
}

export function parsePullRequest(json: string, ref: string, now = Date.now()): PullRequestStatus {
  if (Buffer.byteLength(json, 'utf8') > GH_PR_MAX_BUFFER_BYTES)
    throw new Error('PR observation exceeds output limit');
  const pr = validateSchema(validateGhPullRequest, JSON.parse(json));
  if (
    (pr.state === 'MERGED') !== (pr.mergedAt !== null) ||
    (pr.mergedAt !== null && !Number.isFinite(Date.parse(pr.mergedAt)))
  )
    throw new Error('Inconsistent PR merge observation');
  const identity = canonicalPullRequest(ref);
  if (canonicalPullRequest(pr.url) !== identity) throw new Error('PR identity changed');
  const checks = (pr.statusCheckRollup ?? []).map((check) => ({
    check,
    outcome: checkOutcome(check),
  }));
  const failedChecks = [
    ...new Set(
      checks
        .filter(({ outcome }) => outcome === 'failure')
        .map(({ check }) => check.name || check.context || check.__typename),
    ),
  ].sort();
  const relevant = checks.filter(({ outcome }) => outcome !== 'ignored');
  const ci = failedChecks.length
    ? 'failure'
    : !relevant.length
      ? 'unknown'
      : relevant.every(({ outcome }) => outcome === 'success')
        ? 'success'
        : 'pending';
  return {
    ref: identity,
    state: pr.state,
    isDraft: pr.isDraft,
    reviewDecision: pr.reviewDecision,
    ci,
    failedChecks,
    mergedAt: pr.mergedAt,
    url: identity,
    headRefName: pr.headRefName,
    observedAt: now,
  };
}

export async function readPullRequest(
  repositoryPath: string,
  ref: string,
  signal?: AbortSignal,
  repository?: string,
): Promise<string> {
  validatePrSelector(ref);
  const { stdout } = await execute(
    'gh',
    ['pr', 'view', ref, ...(repository ? ['--repo', repository] : []), '--json', GH_PR_FIELDS],
    {
      cwd: repositoryPath,
      windowsHide: true,
      timeout: GH_PR_TIMEOUT_MS,
      maxBuffer: GH_PR_MAX_BUFFER_BYTES,
      signal,
      env: withoutOperatorToken({ ...process.env, GH_PROMPT_DISABLED: '1' }),
    },
  );
  return stdout;
}

export async function resolvePullRequestBinding(
  repositoryPath: string,
  repository: string,
  selector: string,
  read = readPullRequest,
): Promise<string> {
  validatePrSelector(selector);
  if (/^\d+$/.test(selector) && !/^[1-9]\d*$/.test(selector)) throw new Error('Invalid PR number');
  const query = /^[1-9]\d*$/.test(selector) ? `${repository}/pull/${selector}` : selector;
  if (query.includes('://')) canonicalPullRequest(query, repository);
  const json = await read(repositoryPath, query, undefined, repository.replace('https://', ''));
  const data = validateSchema(validateGhPullRequest, JSON.parse(json));
  const ref = canonicalPullRequest(data.url, repository);
  parsePullRequest(json, ref);
  if (query.includes('://') && canonicalPullRequest(query) !== ref)
    throw new Error('PR identity changed');
  return ref;
}

/** An answer records a decision only. Cleanup still requires an explicit human operation. */
function cleanupDecision(task: TaskRecord, pr: PullRequestStatus): NewHumanDecision {
  const policy = evaluatePolicy('delete_worktree', 'system', 'A0');
  return {
    id: randomUUID(),
    context: `pr-cleanup/${task.key}\nPR ${pr.url} merged. Review cleanup of worktree ${task.worktree_ref ? path.win32.basename(task.worktree_ref) : '(unrecorded)'} on branch ${task.branch ?? pr.headRefName}.`,
    options: [
      {
        id: 'review',
        label: 'Revisar limpieza manual',
        benefit: 'Recuperar espacio',
        cost: 'Revisión del operador',
        risk: 'Comprobar cambios locales antes de borrar',
      },
      {
        id: 'keep',
        label: 'Conservar worktree',
        benefit: 'Conservar trabajo local',
        cost: 'Espacio en disco',
        risk: 'Limpieza pendiente',
      },
    ],
    recommendation: 'Revisar el worktree y realizar la limpieza manualmente',
    disagreement: [],
    impact: policy.reason,
    urgency: 'low',
    requestedBy: PR_MONITOR_ACTOR,
    // An idle open Task may request manual cleanup. The store decides atomically.
    blocks: [],
  };
}

export interface PullRequestMonitorOptions {
  repositoryPath: string;
  projectId: string;
  read?: typeof readPullRequest;
  log?: (message: string) => void;
}

export class PullRequestMonitor {
  private timer: NodeJS.Timeout | undefined;
  private pending: Promise<void> | undefined;
  private stopped = false;
  private controller: AbortController | undefined;
  private unavailableLogged = false;
  private persistenceLogged = false;

  constructor(private readonly options: PullRequestMonitorOptions) {}

  start(): void {
    if (this.timer || this.stopped) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), PR_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.pending;
  }

  /** Coalesce slow polls so intervals cannot overlap within one server. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.pending ??= this.poll().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async poll(): Promise<void> {
    let store: WorkStore | undefined;
    const log = this.options.log ?? console.warn;
    try {
      if (this.stopped) return;
      this.controller = new AbortController();
      store = await openWorkStore({ ...this.options, recoverLeases: false });
      for (const task of store.listTasks()) {
        if (this.stopped) break;
        if (!task.pr_ref) continue;
        const poll = await store.beginPullRequestPoll(
          task.key,
          task.pr_ref,
          task.pr_binding_generation!,
        );
        if (!poll) continue;
        let pr: PullRequestStatus;
        try {
          if (canonicalPullRequest(task.pr_ref) !== task.pr_ref)
            throw new Error('Binding requires canonical identity');
        } catch {
          await store.recordPullRequestError(task.key, task.pr_ref, 'binding_required', poll);
          continue;
        }
        try {
          const json = await (this.options.read ?? readPullRequest)(
            this.options.repositoryPath,
            task.pr_ref,
            this.controller.signal,
          );
          pr = parsePullRequest(json, task.pr_ref);
        } catch {
          if (this.stopped) break;
          await store.recordPullRequestError(task.key, task.pr_ref, 'unavailable', poll);
          if (!this.unavailableLogged) {
            log(
              '[PR monitor] gh unavailable, unauthenticated or unreadable; observation unavailable.',
            );
            this.unavailableLogged = true;
          }
          continue;
        }
        if (this.stopped) break;
        try {
          await store.observePullRequest(
            task.key,
            task.version,
            task.pr_ref,
            pr,
            pr.state === 'MERGED' ? cleanupDecision(task, pr) : undefined,
            poll,
          );
        } catch {
          // Includes concurrent Task changes. Retry against a fresh generation next poll.
          if (!this.persistenceLogged) {
            log('[PR monitor] Observation deferred; retrying with fresh WorkStore state.');
            this.persistenceLogged = true;
          }
        }
      }
    } catch {
      if (!this.persistenceLogged) {
        log('[PR monitor] WorkStore unavailable; retrying next poll.');
        this.persistenceLogged = true;
      }
    } finally {
      store?.close();
      this.controller = undefined;
    }
  }
}

export function createPullRequestMonitor(
  selection: BoardSelection,
): PullRequestMonitor | undefined {
  if (selection.kind !== 'project') return undefined;
  return new PullRequestMonitor({
    repositoryPath: selection.project.repoRoot,
    projectId: selection.project.project.id,
  });
}
