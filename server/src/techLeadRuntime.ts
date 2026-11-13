import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TECH_LEAD_SPEC } from '../../core/src/agentSpec.js';
import type { ProjectConfig } from '../../core/src/project.js';
import { architectContext } from './architect.js';
import { readTaskInput, taskPath } from './commands/taskFiles.js';
import {
  FEATURE_IDEAS_DIRECTORY,
  PROJECT_MANIFEST_PATH,
  USAGE_BUDGET_MINUTE_MS,
  USAGE_BUDGET_SECOND_MS,
} from './constants.js';
import type { ProbeRunner } from './executorProbes.js';
import { ClaudeCliExecutor } from './executors/claudeCliExecutor.js';
import type { Executor } from './executors/executor.js';
import { featureDocument } from './featureArtifacts.js';
import { resolveClaudeBinary } from './modelTiers.js';
import { materializeStackAdr, proposeProjectStack, stackDecision } from './projectStack.js';
import type { ResearchAdapters } from './research.js';
import { researchPolicy } from './researchPolicy.js';
import { researchBudget } from './researchRuntime.js';
import { STACK_PROPOSAL_SCHEMA, validateStackProposal } from './techLead.js';
import { techLeadExecutor } from './techLeadExecution.js';
import { researchJson, researchStack, techLeadEvidence } from './techLeadResearch.js';
import { WorkerLifecycle } from './workerLifecycle.js';
import type { WorkStore } from './workstore/WorkStore.js';

export interface TechLeadOptions {
  executor?: Executor;
  adapters?: ResearchAdapters;
  probe?: ProbeRunner;
}

/** Approval and design resumes share this idempotent role pipeline. */
export async function ensureProjectStack(
  store: WorkStore,
  config: ProjectConfig,
  key: string,
  options: TechLeadOptions = {},
): Promise<void> {
  const existing = stackDecision(store, key);
  if (existing) {
    materializeStackAdr(config, existing, store);
    return;
  }
  if (store.getDesign(key)) return;
  const feature = store.getFeature(key);
  if (feature?.status !== 'approved') throw new Error('Tech Lead requires approved requirements');
  // FeatureSpec is read from its SHA-bound branch, with the same guards as Architect.
  const { spec } = featureDocument(store, config, feature);
  const taskKey = `${key}-STACK`;
  if (!store.getTask(taskKey))
    store.createTask({
      key: taskKey,
      type: 'architecture',
      status: 'DRAFT',
      feature_key: key,
      agent_role: 'tech-lead',
    });
  const lifecycle = new WorkerLifecycle(store, taskKey);
  const policy = researchPolicy('quick', config.operator.research);
  const budgets = config.operator.budgets;
  const usage = store.listUsage();
  const previous = usage.filter((entry) => entry.taskKey === taskKey);
  const remainingTokens = (entries: typeof usage, limit?: number) => {
    if (limit === undefined) return Infinity;
    return (
      limit -
      entries.reduce(
        (total, entry) => total + (entry.inputTokens ?? limit) + (entry.outputTokens ?? limit),
        0,
      )
    );
  };
  policy.maxTokens = Math.min(
    policy.maxTokens,
    remainingTokens(previous, budgets?.maxTokens),
    remainingTokens(
      usage.filter((entry) => entry.day === new Date().toISOString().slice(0, 10)),
      budgets?.maxTokensPerDay,
    ),
  );
  const costLimit = budgets?.maxCostUsd;
  const remainingCost =
    costLimit === undefined
      ? Infinity
      : costLimit - previous.reduce((total, entry) => total + (entry.costUsd ?? costLimit), 0);
  policy.maxCostUsd = Math.min(policy.maxCostUsd, remainingCost);
  policy.maxSeconds = Math.min(
    policy.maxSeconds,
    budgets?.maxExecutionSeconds ?? Infinity,
    ((budgets?.maxExecutionMinutes ?? Infinity) * USAGE_BUDGET_MINUTE_MS) / USAGE_BUDGET_SECOND_MS,
  );
  const id = randomUUID();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), policy.maxSeconds * USAGE_BUDGET_SECOND_MS);
  const interrupt = () => abort.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    await lifecycle.claim();
    const underlying =
      options.executor ??
      new ClaudeCliExecutor({
        binary: resolveClaudeBinary(config.operator.binaryPaths?.claude),
        configDir: config.operator.executors?.claude?.configDir,
        runtimeDirectory: path.join(os.homedir(), '.pixel-agents', 'research-runtime', id),
      });
    if (underlying.id !== 'claude')
      throw new Error('Tech Lead requires the tool-free Claude executor');
    const gaps: string[] = [];
    const budget = researchBudget(
      techLeadExecutor(underlying, config, store, lifecycle, options.probe),
      policy,
      abort,
      gaps,
    );
    const request = {
      executionId: id,
      projectId: config.project.id,
      taskKey,
      flags: [],
      prompt: '',
      worktreePath: config.repoRoot,
      timeoutMin: (policy.maxSeconds * USAGE_BUDGET_SECOND_MS) / USAGE_BUDGET_MINUTE_MS,
    };
    const research = await researchStack(
      budget.executor,
      request,
      policy,
      abort.signal,
      options.adapters,
    );
    const ideaPath =
      store.getFeatureRun(key)?.state.request ??
      `${FEATURE_IDEAS_DIRECTORY}/${config.project.id}/${key}.md`;
    const idea = fs.existsSync(taskPath(config.repoRoot, ideaPath))
      ? readTaskInput(config.repoRoot, ideaPath)
      : null;
    const output = await researchJson(
      budget.executor,
      {
        ...request,
        role: 'tech-lead',
        agentSpec: TECH_LEAD_SPEC,
        taskData: {
          task: {
            provenance: 'untrusted-external',
            idea,
            approvedRequirements: spec,
            projectManifest: readTaskInput(config.repoRoot, PROJECT_MANIFEST_PATH),
            constraints: architectContext(config.repoRoot, config.project.brain.path),
            research: techLeadEvidence(research),
          },
          outputSchema: STACK_PROPOSAL_SCHEMA,
        },
      },
      abort.signal,
    );
    lifecycle.assertOwned();
    if (store.getFeature(key)?.git_sha !== feature.git_sha)
      throw new Error('Approved requirements changed during stack proposal');
    await proposeProjectStack(
      store,
      config,
      key,
      validateStackProposal(output, research.bibliography),
      research.bibliography,
    );
    await lifecycle.finish('REVIEW', 'Stack propuesto; decisión humana pendiente');
  } catch (error) {
    if (store.getTask(taskKey)?.lease_owner === lifecycle.owner) {
      if (
        store
          .listExecutions()
          .some((execution) => execution.task_key === taskKey && !execution.tree_closed_at)
      )
        await lifecycle.retainForRecovery();
      else
        await lifecycle.finish(
          'FAILED_RETRYABLE',
          'Tech Lead requiere reintento; el diseño conserva su gate',
        );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await lifecycle.stopHeartbeat();
  }
}
