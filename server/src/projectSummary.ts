import * as fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import * as decisionSchema from '../../core/schemas/human-decision.schema.json';
import type { HumanDecision } from '../../core/src/humanDecision.js';
import type {
  ProjectSummary,
  ProjectSummaryItem,
  ProjectSummarySnapshot,
} from '../../core/src/messages.js';
import { type AuditViewResult, readAuditView } from './auditView.js';
import { companyWorkspaceRoot } from './companyControl.js';
import {
  PROJECT_SUMMARY_ACTIVE_TASK_STATES,
  PROJECT_SUMMARY_BLOCK_LABELS,
  PROJECT_SUMMARY_DECISION_LABELS,
  PROJECT_SUMMARY_GATE_LABELS,
  PROJECT_SUMMARY_RECENT_LIMIT,
} from './constants.js';
import {
  type FeaturesSource,
  featureUsageEntry,
  projectFeatures,
  readFeaturesSource,
} from './featuresView.js';
import { loadProjectConfig } from './projectConfig.js';
import { readSummaryContext, type SummaryContext, summaryText } from './projectSummaryContext.js';
import { projectWorkflow } from './projectWorkflow.js';
import { compileSchema, validateSchema } from './schemaValidation.js';
import { taskDecisionText } from './taskChangeDecisions.js';
import { taskDeclarationText } from './taskDetailProjection.js';
import { telemetrySummary } from './telemetryCommand.js';
import { aggregateUsage } from './usageLedger.js';
import {
  FeaturesReadFailure,
  gitCommonDir,
  openReadOnlyWorkStore,
  workStoreFile,
} from './workstore/readOnlyWorkStore.js';
import { canStart, isTaskStatus } from './workstore/taskStateMachine.js';

const validateDecision = compileSchema<HumanDecision>(decisionSchema);

export interface ProjectSummarySource {
  name: string;
  work: FeaturesSource;
  dependencies: { task_key: string; depends_on_key: string }[];
  context: SummaryContext;
  audit: AuditViewResult;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new FeaturesReadFailure('invalid_data');
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function at(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = Date.parse(text(value));
  if (!Number.isFinite(date)) throw new FeaturesReadFailure('invalid_data');
  return new Date(date).toISOString();
}

function recent(items: ProjectSummaryItem[]): ProjectSummaryItem[] {
  return items
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || a.key.localeCompare(b.key))
    .slice(0, PROJECT_SUMMARY_RECENT_LIMIT);
}

/** All product meaning and ordering are projected here, before the transport boundary. */
export function projectSummary(
  source: ProjectSummarySource,
  features = projectFeatures(source.work),
): ProjectSummary {
  const tasks = source.work.tasks.map((row) => {
    const key = text(row.key);
    const status = text(row.status);
    if (!isTaskStatus(status)) throw new FeaturesReadFailure('invalid_data');
    const declaration = nullableText(row.declaration);
    const title = taskDeclarationText(declaration).title ?? key;
    if (typeof row.priority !== 'number' || !Number.isFinite(row.priority))
      throw new FeaturesReadFailure('invalid_data');
    return {
      key,
      status,
      title: summaryText(title),
      priority: row.priority,
      feature: nullableText(row.feature_key),
      dag: declaration !== null && /^FEAT-\d{3}-T\d{2}$/.test(key),
      at: at(row.updated_at),
      blocked: summaryText(nullableText(row.blocked_reason) ?? ''),
    };
  });
  const decisions = source.work.decisions
    .filter((row) => row.escalation !== null && row.escalation !== undefined)
    .map((row) => validateSchema(validateDecision, JSON.parse(text(row.escalation))))
    .filter((decision) => decision.status !== 'answered');
  const decisionItems = decisions.map((decision) => {
    const label = PROJECT_SUMMARY_DECISION_LABELS[decision.context.split('/')[0]];
    const affected = decision.blocks.map(
      (key) => tasks.find((task) => task.key === key)?.title ?? key,
    );
    return {
      key: summaryText(decision.id),
      text: summaryText(
        label
          ? [label, ...affected].join(' · ')
          : taskDecisionText(decision.context).replace(/^feature-requirements\/[^\n]+\n/, ''),
      ),
      at: null,
    };
  });
  const gates = features.flatMap((feature) =>
    feature.gates.map((gate, index) => ({
      key: `${feature.key}-${gate.kind}-${gate.task ?? ''}-${index}`,
      text: `${PROJECT_SUMMARY_GATE_LABELS[gate.kind]} · ${feature.title ?? feature.key}${gate.reason ? ` · ${summaryText(gate.reason)}` : ''}`,
      at: null,
    })),
  );
  const ready = tasks
    .filter(
      (task) =>
        task.status === 'READY' &&
        canStart({
          dependencies: source.dependencies
            .filter((edge) => edge.task_key === task.key)
            .map((edge) => tasks.find((dependency) => dependency.key === edge.depends_on_key)),
        }) &&
        !decisions.some(
          (decision) =>
            decision.blocks.includes(task.key) ||
            (!!task.feature && decision.blocks.includes(task.feature)),
        ),
    )
    .sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key))
    .map((task) => ({ key: task.key, text: `Preparada para empezar · ${task.title}`, at: null }));
  const milestones = features.flatMap((feature) => {
    const title = feature.title ?? feature.key;
    const result: ProjectSummaryItem[] = [];
    if (feature.state === 'merged')
      result.push({
        key: `${feature.key}-merged`,
        text: `Funcionalidad integrada · ${title}`,
        at: feature.lastActivityAt,
      });
    if (['in_design', 'in_development', 'ready_to_merge', 'merged'].includes(feature.state))
      result.push({
        key: `${feature.key}-spec`,
        text: `Requisitos aprobados · ${title}`,
        at: null,
      });
    if (source.work.designs.some((design) => design.feature_key === feature.key))
      result.push({ key: `${feature.key}-design`, text: `Diseño preparado · ${title}`, at: null });
    return result;
  });
  // Only confirmed audit facts contribute. Payloads and answers never cross this boundary.
  for (const entry of source.audit.entries) {
    if (entry.action !== 'approve_featurespec' || entry.outcome.status !== 'approved') continue;
    const feature = features.find((feature) => feature.key === entry.resourceId);
    if (!feature) continue;
    const milestone = milestones.find((item) => item.key === `${feature.key}-spec`);
    if (milestone && milestone.at === null) milestone.at = at(entry.occurredAt);
  }
  const usage = aggregateUsage((source.work.ledger ?? []).map(featureUsageEntry), tasks);
  const finite = (value: number | null) =>
    value !== null && Number.isFinite(value) ? value : null;
  const notices = [...source.context.notices];
  if (source.audit.status === 'read_error')
    notices.push('No se pudo leer el historial de auditoría.');
  if (source.audit.corruptLines.length)
    notices.push('El historial de auditoría contiene entradas ilegibles.');
  return {
    name: summaryText(source.name),
    goals: source.context.goals,
    features: features.map((feature) => {
      const work = tasks.filter((task) => task.feature === feature.key && task.dag);
      const done = work.filter((task) => task.status === 'DONE').length;
      const inProgress = work.filter((task) =>
        PROJECT_SUMMARY_ACTIVE_TASK_STATES.includes(task.status),
      ).length;
      const cancelled = work.filter((task) => task.status === 'CANCELLED').length;
      return {
        key: feature.key,
        title: feature.title,
        state:
          feature.state === 'merged'
            ? 'summary_done'
            : inProgress > 0 ||
                done > 0 ||
                ['in_design', 'in_development', 'ready_to_merge'].includes(feature.state)
              ? 'summary_in_progress'
              : 'summary_pending',
        done,
        inProgress,
        pending: work.length - done - inProgress - cancelled,
        cancelled,
        total: work.length,
      };
    }),
    milestones: recent(milestones),
    deliveries: recent([
      ...features
        .filter((feature) => feature.state === 'merged')
        .map((feature) => ({
          key: feature.key,
          text: `Funcionalidad integrada · ${feature.title ?? feature.key}`,
          at: feature.lastActivityAt,
        })),
      ...tasks
        .filter((task) => task.dag && task.status === 'DONE')
        .map((task) => ({
          key: task.key,
          text: `Tarea terminada · ${task.title}`,
          at: task.at,
        })),
    ]),
    decisions: decisionItems,
    risks: source.context.risks,
    blockers: [
      ...gates,
      ...tasks
        .filter((task) => PROJECT_SUMMARY_BLOCK_LABELS[task.status])
        .map((task) => ({
          key: task.key,
          text: `${PROJECT_SUMMARY_BLOCK_LABELS[task.status]} · ${task.title}${task.blocked ? ` · ${task.blocked}` : ''}`,
          at: task.at,
        })),
    ],
    nextSteps: [
      ...decisionItems.map((item) => ({ ...item, text: `Responder · ${item.text}` })),
      ...gates,
      ...source.context.nextSteps,
      ...features
        .filter((feature) => feature.state === 'ready_to_merge')
        .map((feature) => ({
          key: feature.key,
          text: `Integrar la funcionalidad · ${feature.title ?? feature.key}`,
          at: null,
        })),
      ...ready,
    ].slice(0, PROJECT_SUMMARY_RECENT_LIMIT),
    cost: {
      source: usage.executions ? 'ledger' : 'none',
      executions: usage.executions,
      costKnown: usage.costCoverage,
      costUsd: finite(usage.costUsd),
      inputTokens: finite(usage.inputTokens),
      outputTokens: finite(usage.outputTokens),
      tokenKnown: usage.tokenCoverage,
    },
    notices,
    workflow: projectWorkflow(source.work, features, source.context, decisions),
  };
}

export async function readProjectSummary(
  root: string,
  projectId: string,
): Promise<Pick<ProjectSummarySnapshot, 'status' | 'reason' | 'summary'>> {
  let db: DatabaseSync | undefined;
  try {
    const config = loadProjectConfig(root);
    if (!config || config.project.id !== projectId)
      return { status: 'unknown_project', reason: null, summary: null };
    let work: FeaturesSource = {
      features: [],
      designs: [],
      tasks: [],
      runs: [],
      decisions: [],
      executions: [],
      events: [],
    };
    let dependencies: ProjectSummarySource['dependencies'] = [];
    // A new Project has no WorkStore yet. An existing unreadable store is an error.
    if (fs.existsSync(workStoreFile(config.repoRoot))) {
      db = openReadOnlyWorkStore(config.repoRoot);
      db.exec('BEGIN');
      work = await readFeaturesSource(db, config.repoRoot, projectId);
      dependencies = db
        .prepare('SELECT task_key, depends_on_key FROM task_dependencies WHERE project_id = ?')
        .all(projectId)
        .map((row) => ({ task_key: text(row.task_key), depends_on_key: text(row.depends_on_key) }));
    }
    const features = projectFeatures(work);
    const context = readSummaryContext(config, features);
    const summary = projectSummary(
      {
        name: config.project.name,
        work,
        dependencies,
        context,
        audit: await readAuditView(projectId),
      },
      features,
    );
    // Retained telemetry is an alternative source when the ledger has no records.
    // Never add the two histories or reprice old consumption using current tariffs.
    if (summary.cost.source === 'none') {
      const telemetry = await telemetrySummary(gitCommonDir(config.repoRoot), projectId);
      if (telemetry.invalidLines)
        summary.notices.push('La telemetría contiene entradas ilegibles.');
      if (telemetry.total.executions > 0) {
        const count = (value: number | 'unknown') =>
          typeof value === 'number' && Number.isFinite(value) ? value : null;
        summary.cost = {
          source: 'retained_telemetry',
          executions: telemetry.total.executions,
          costKnown: 0,
          costUsd: null,
          inputTokens: count(telemetry.total.inputTokens),
          outputTokens: count(telemetry.total.outputTokens),
          tokenKnown: null,
        };
      }
    }
    return {
      status:
        features.length ||
        work.tasks.length ||
        context.goals.length ||
        context.nextSteps.length ||
        summary.decisions.length ||
        summary.cost.executions ||
        summary.notices.length
          ? 'ok'
          : 'empty',
      reason: null,
      summary,
    };
  } catch (error) {
    return {
      status: 'read_error',
      reason: error instanceof FeaturesReadFailure ? error.reason : 'query_failed',
      summary: null,
    };
  } finally {
    db?.close();
  }
}

/** Read authority comes from the connection, before resolving the bound repository. */
export async function handleProjectSummaryMessage(
  msg: Record<string, unknown>,
  send: (message: Record<string, unknown>) => void,
  privileged: boolean,
): Promise<void> {
  if (typeof msg.projectId !== 'string' || typeof msg.requestId !== 'string') return;
  const base = {
    type: 'projectSummarySnapshot',
    projectId: msg.projectId,
    requestId: msg.requestId,
  };
  if (!privileged) return send({ ...base, status: 'denied', reason: null, summary: null });
  if (Object.keys(msg).some((key) => !['type', 'projectId', 'requestId'].includes(key))) return;
  const root = companyWorkspaceRoot();
  if (!root) return send({ ...base, status: 'unknown_project', reason: null, summary: null });
  send({ ...base, ...(await readProjectSummary(root, msg.projectId)) });
}
