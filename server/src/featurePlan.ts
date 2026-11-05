import { createHash } from 'node:crypto';

import { FEATURE_PLAN_SECTIONS } from '../../core/src/featurePlan.js';
import type { FeaturePlan, FeaturePlanError } from '../../core/src/messages.js';
import type { ProjectConfig } from '../../core/src/project.js';
import { approveFeature, FeatureApprovedAuditPending } from './commands/feature.js';
import { companyWorkspaceRoot } from './companyControl.js';
import { FEATURE_PLAN_HEADINGS, FEATURE_PLAN_REVISION_PATTERN } from './constants.js';
import { featureDocument } from './featureArtifacts.js';
import { featureIngressActor } from './featureIngress.js';
import { loadProjectConfig } from './projectConfig.js';
import { openReadOnlyWorkStore } from './workstore/readOnlyWorkStore.js';
import { openWorkStore } from './workstore/SqliteWorkStore.js';
import type { DesignRecord, FeatureRecord, TaskRecord, WorkStore } from './workstore/WorkStore.js';
import { FeatureRevisionChangedError } from './workstore/WorkStore.js';

type PlanStore = Pick<WorkStore, 'getFeature' | 'getTask' | 'getDesign'>;

export class StaleFeaturePlan extends Error {
  constructor() {
    super('stale_revision');
  }
}

/** Only explicit Markdown headings contribute specialized sections. Text stays literal. */
export function designSection(source: string | null, heading: RegExp): string | null {
  const lines = source?.split(/\r?\n/) ?? [];
  const result: string[] = [];
  let depth = 0;
  let fence: string | undefined;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || marker.startsWith(fence))) fence = fence ? undefined : marker;
    const match = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match && depth && match[1].length <= depth) depth = 0;
    if (match && heading.test(match[2])) depth = match[1].length;
    if (depth) result.push(line);
  }
  return result.join('\n').trim() || null;
}

/** This projection reads only already-bound artifacts, with the CLI's Git fence. */
export function projectFeaturePlan(
  store: PlanStore,
  config: ProjectConfig,
  key: string,
): FeaturePlan {
  const feature = store.getFeature(key);
  if (!feature) throw new Error('Unknown Feature');
  const { spec, sources } = featureDocument(store, config, feature);
  const content = {
    requirements: sources.requirements,
    architecture: sources.design,
    tasks: sources.dag,
    tests: designSection(sources.design, FEATURE_PLAN_HEADINGS.tests),
    ci: designSection(sources.design, FEATURE_PLAN_HEADINGS.ci),
    security: designSection(sources.design, FEATURE_PLAN_HEADINGS.security),
    documentation: designSection(sources.design, FEATURE_PLAN_HEADINGS.documentation),
  };
  return {
    key,
    title: spec.title,
    specSha: feature.git_sha,
    // Approval changes operational state, never the revision the human reviewed.
    revision: createHash('sha256')
      .update(JSON.stringify({ key, specSha: feature.git_sha, sources }))
      .digest('hex'),
    approved: ['approved', 'ready_to_merge'].includes(feature.status),
    sections: FEATURE_PLAN_SECTIONS.map((section) => ({
      ...section,
      content: content[section.id],
    })),
  };
}

export function readFeaturePlan(config: ProjectConfig, key: string): FeaturePlan {
  const db = openReadOnlyWorkStore(config.repoRoot);
  try {
    db.exec('BEGIN');
    const get = (table: string, column: string, key: string) =>
      db
        .prepare(`SELECT * FROM ${table} WHERE project_id = ? AND ${column} = ?`)
        .get(config.project.id, key);
    const store: PlanStore = {
      getFeature: (key) => get('features', 'key', key) as unknown as FeatureRecord | undefined,
      getTask: (key) => get('tasks', 'key', key) as unknown as TaskRecord | undefined,
      getDesign: (key) =>
        get('technical_designs', 'feature_key', key) as unknown as DesignRecord | undefined,
    };
    return projectFeaturePlan(store, config, key);
  } finally {
    db.close();
  }
}

/** Approval privilege precedes any Project access. Client actor fields are rejected. */
export async function handleFeaturePlanMessage(
  msg: Record<string, unknown>,
  send: (message: Record<string, unknown>) => void,
  privileged: boolean,
  supported = true,
): Promise<void> {
  if (msg.type !== 'requestFeaturePlan' && msg.type !== 'approveFeaturePlan') return;
  if (
    typeof msg.projectId !== 'string' ||
    typeof msg.requestId !== 'string' ||
    typeof msg.key !== 'string'
  )
    return;
  const approving = msg.type === 'approveFeaturePlan';
  const base = { projectId: msg.projectId, requestId: msg.requestId, key: msg.key };
  const reply = (errorCode: FeaturePlanError | null, plan: FeaturePlan | null = null) => {
    if (approving)
      send({
        ...base,
        type: 'featureApprovalResult',
        revision: typeof msg.revision === 'string' ? msg.revision : '',
        status: errorCode ? 'rejected' : 'approved',
        errorCode,
      });
    else
      send({
        ...base,
        type: 'featurePlanSnapshot',
        plan,
        canApprove:
          !errorCode && privileged && featureIngressActor() === 'human' && !plan?.approved,
        errorCode,
      });
  };
  if (!supported) return reply('unsupported_adapter');
  if (approving && (!privileged || featureIngressActor() !== 'human')) return reply('denied');
  const allowed = ['type', 'projectId', 'requestId', 'key', ...(approving ? ['revision'] : [])];
  if (
    Object.keys(msg).some((key) => !allowed.includes(key)) ||
    !/^FEAT-\d{3}$/.test(msg.key) ||
    (approving &&
      (typeof msg.revision !== 'string' || !FEATURE_PLAN_REVISION_PATTERN.test(msg.revision)))
  )
    return reply('invalid_request');
  let config: ProjectConfig;
  try {
    const root = companyWorkspaceRoot();
    const bound = root && loadProjectConfig(root, approving);
    if (!bound || bound.project.id !== msg.projectId) return reply('unknown_project');
    config = bound;
    const plan = readFeaturePlan(config, msg.key);
    if (!approving) return reply(null, plan);
    if (plan.revision !== msg.revision) return reply('stale_revision');
    const store = await openWorkStore({
      repositoryPath: config.repoRoot,
      projectId: config.project.id,
    });
    try {
      await approveFeature(store, config, msg.key, 'human', undefined, {
        gitSha: plan.specSha,
        beforeCommit: () => {
          if (projectFeaturePlan(store, config, base.key).revision !== msg.revision)
            throw new StaleFeaturePlan();
        },
      });
      reply(null);
    } finally {
      store.close();
    }
  } catch (error) {
    // The approval is durable; only its confirmation entry failed.
    if (error instanceof FeatureApprovedAuditPending) return reply(null);
    reply(
      error instanceof StaleFeaturePlan || error instanceof FeatureRevisionChangedError
        ? 'stale_revision'
        : approving
          ? 'approval_blocked'
          : 'unavailable',
    );
  }
}
