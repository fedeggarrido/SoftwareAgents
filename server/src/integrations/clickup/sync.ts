import { AuditLog } from '../../auditLog.js';
import { CLICKUP_SYNC_INTERVAL_MS } from '../../constants.js';
import { evaluatePolicy, type PolicyActor } from '../../policy.js';
import { loadProjectConfig } from '../../projectConfig.js';
import { openWorkStore } from '../../workstore/SqliteWorkStore.js';
import { type ClickUpClient, clickUpToken, createClickUpClient } from './client.js';
import { type MirrorOutcome, reconcileClickUp } from './mirror.js';

/** Why a Project cannot be mirrored; the CLI shows it, the office stays quiet. */
export class ClickUpMirrorUnavailable extends Error {}

export interface SyncOptions {
  actor: PolicyActor;
  dryRun?: boolean;
  client?: ClickUpClient;
}

/** One reconciliation of the bound Project: config, token and policy are checked every time. */
export async function syncClickUp(root: string, options: SyncOptions): Promise<MirrorOutcome[]> {
  const config = loadProjectConfig(root, true);
  if (!config)
    throw new ClickUpMirrorUnavailable(
      'clickup requires a bound Git Project (.softwareagents/project.yaml)',
    );
  const mirror = config.operator.clickupMirror;
  if (!mirror?.enabled)
    throw new ClickUpMirrorUnavailable(
      'El espejo de ClickUp está desactivado para este proyecto (clickupMirror.enabled).',
    );
  const listIds = config.project.clickup?.listIds ?? [];
  if (!listIds.length)
    throw new ClickUpMirrorUnavailable(
      'project.yaml no enlaza ninguna lista de ClickUp (clickup.listIds).',
    );
  const token = options.client ? null : clickUpToken();
  const client = options.client ?? (token ? createClickUpClient({ token }) : null);
  if (!client)
    throw new ClickUpMirrorUnavailable(
      'Falta el token de ClickUp: CLICKUP_TOKEN o ~/.pixel-agents/secrets.json.',
    );
  const store = await openWorkStore({ repositoryPath: root, projectId: config.project.id });
  const audit = new AuditLog();
  try {
    return await reconcileClickUp({
      tasks: store.listTasks(),
      listIds,
      config: mirror,
      client,
      actor: options.actor,
      authorize: (who) => evaluatePolicy('clickup_write', who, config.operator.autonomyLevel),
      dryRun: options.dryRun,
      record: (event) =>
        audit.append({
          projectId: config.project.id,
          actorType: options.actor,
          actorId: options.actor === 'human' ? 'operator' : 'clickup-mirror',
          action: event.action,
          resourceType: 'task',
          resourceId: event.key,
          policyDecision: null,
          riskLevel: 'low',
          outcome: { status: event.status, detail: event.detail },
          taskKey: event.key,
          executionId: null,
          input: { clickupId: event.clickupId },
        }),
    });
  } finally {
    store.close();
  }
}

/** Office timer: reconciles every few minutes while the Project opts in; never overlaps itself. */
export function startClickUpMirror(root: string): { dispose(): void } {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await syncClickUp(root, { actor: 'system' });
    } catch (error) {
      // Not opted in (or no token) is the normal case: stay quiet. ClickUpError carries no token.
      if (!(error instanceof ClickUpMirrorUnavailable))
        console.error(`[Pixel Agents] ClickUp mirror: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), CLICKUP_SYNC_INTERVAL_MS);
  timer.unref();
  return { dispose: () => clearInterval(timer) };
}
