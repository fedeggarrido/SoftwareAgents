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
  PR_MONITOR_ACTOR,
  PR_POLL_INTERVAL_MS,
} from './constants.js';
import { withoutOperatorToken } from './featureIngress.js';
import { evaluatePolicy } from './policy.js';
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
    mergedAt: { type: ['string', 'null'] },
    url: { type: 'string', pattern: '^https://[^/]+/[^/]+/[^/]+/pull/[0-9]+$' },
    headRefName: { type: 'string', minLength: 1 },
    statusCheckRollup: {
      type: ['array', 'null'],
      items: {
        type: 'object',
        required: ['__typename'],
        properties: {
          __typename: { enum: ['CheckRun', 'StatusContext'] },
          name: { type: 'string' },
          context: { type: 'string' },
          conclusion: { type: ['string', 'null'] },
          status: { type: 'string' },
          state: { type: 'string' },
        },
      },
    },
  },
});

export function parsePullRequest(json: string, ref: string, now = Date.now()): PullRequestStatus {
  const pr = validateSchema(validateGhPullRequest, JSON.parse(json));
  if (
    (pr.state === 'MERGED') !== (pr.mergedAt !== null) ||
    (pr.mergedAt !== null && !Number.isFinite(Date.parse(pr.mergedAt)))
  )
    throw new Error('Inconsistent PR merge observation');
  const checks = pr.statusCheckRollup ?? [];
  const conclusion = (check: GhCheck) =>
    check.__typename === 'StatusContext' ? check.state : check.conclusion;
  const failedChecks = [
    ...new Set(
      checks
        .filter((check) => GH_FAILED_CONCLUSIONS.includes(conclusion(check) ?? ''))
        .map((check) => check.name || check.context || check.__typename),
    ),
  ].sort();
  const relevant = checks.filter(
    (check) => !GH_IGNORED_CONCLUSIONS.includes(conclusion(check) ?? ''),
  );
  const ci = failedChecks.length
    ? 'failure'
    : !relevant.length
      ? 'unknown'
      : relevant.every((check) => conclusion(check) === 'SUCCESS')
        ? 'success'
        : 'pending';
  return {
    ref,
    state: pr.state,
    isDraft: pr.isDraft,
    reviewDecision: pr.reviewDecision,
    ci,
    failedChecks,
    mergedAt: pr.mergedAt,
    url: pr.url,
    headRefName: pr.headRefName,
    observedAt: now,
  };
}

export async function readPullRequest(repositoryPath: string, ref: string): Promise<string> {
  // Reject flag-like selectors even though execFile never invokes a shell.
  if (!ref.trim() || ref.startsWith('-') || /[\u0000-\u001f\u007f]/.test(ref))
    throw new Error('Invalid PR reference');
  const { stdout } = await execute('gh', ['pr', 'view', ref, '--json', GH_PR_FIELDS], {
    cwd: repositoryPath,
    windowsHide: true,
    timeout: GH_PR_TIMEOUT_MS,
    maxBuffer: GH_PR_MAX_BUFFER_BYTES,
    env: withoutOperatorToken({ ...process.env, GH_PROMPT_DISABLED: '1' }),
  });
  return stdout;
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
    // A merged Task may already be DONE. The gate concerns deletion, not task execution.
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
  private unavailableLogged = false;
  private persistenceLogged = false;

  constructor(private readonly options: PullRequestMonitorOptions) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), PR_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Coalesce slow polls so intervals cannot overlap within one server. */
  tick(): Promise<void> {
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
      store = await openWorkStore(this.options);
      for (const task of store.listTasks()) {
        if (this.stopped) break;
        if (!task.pr_ref) continue;
        let pr: PullRequestStatus;
        try {
          const json = await (this.options.read ?? readPullRequest)(
            this.options.repositoryPath,
            task.pr_ref,
          );
          pr = parsePullRequest(json, task.pr_ref);
        } catch {
          if (!this.unavailableLogged) {
            log(
              '[PR monitor] gh unavailable, unauthenticated or unreadable; observations unchanged.',
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
