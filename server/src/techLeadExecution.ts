import type { AgentSpec } from '../../core/src/agentSpec.js';
import type { ProjectConfig } from '../../core/src/project.js';
import { compileAgent } from './agentCompiler.js';
import { executorAuthorityBlock } from './executorAvailability.js';
import { observeExecutors, type ProbeRunner } from './executorProbes.js';
import type { ExecutionEvent, Executor } from './executors/executor.js';
import { selectExecutor } from './executorSelection.js';
import { acquireExecutorSlot, withMachineAdmission } from './executorSlots.js';
import { loadModelPolicy, loadTierRule } from './modelPolicy.js';
import { admitModelTier } from './modelTierAdmission.js';
import { validateModelTierSupport } from './modelTiers.js';
import { readSelectionSnapshot } from './quotaCommand.js';
import { admissionBudgetReason, usageEntry } from './usageLedger.js';
import type { WorkerLifecycle } from './workerLifecycle.js';
import type { WorkStore } from './workstore/WorkStore.js';

/** Each Researcher/scout/Tech Lead call uses the same Operator admission and ledger. */
export function techLeadExecutor(
  underlying: Executor,
  config: ProjectConfig,
  store: WorkStore,
  lifecycle: WorkerLifecycle,
  probe?: ProbeRunner,
): Executor {
  return {
    id: underlying.id,
    start(request) {
      let active: ReturnType<Executor['start']> | undefined;
      let cancelled = false;
      return {
        cancel() {
          cancelled = true;
          active?.cancel();
        },
        events: (async function* (): AsyncGenerator<ExecutionEvent> {
          lifecycle.assertOwned();
          if (!request.agentSpec || !request.taskData)
            throw new Error('Missing stack role declaration');
          const spec: AgentSpec = request.agentSpec;
          const compiled = compileAgent(spec, request.role, request.taskData);
          const task = store.getTask(lifecycle.task)!;
          const feature = task.feature_key && store.getFeature(task.feature_key);
          if (!feature) throw new Error('Tech Lead execution requires its bound Feature');
          const authorityBlock = () => executorAuthorityBlock(config.project.id, config.operator);
          const blocked = admissionBudgetReason(
            config.operator.budgets,
            store.listUsage(),
            lifecycle.task,
            undefined,
            store.listExecutions().filter((execution) => execution.task_key === lifecycle.task)
              .length,
          );
          if (blocked) throw new Error(`Tech Lead budget exhausted (${blocked})`);
          const availability = await observeExecutors(
            config.operator.allowedExecutors.includes('claude') ? ['claude'] : [],
            config.operator,
            probe,
          );
          const policy = config.operator.modelTiers;
          const inputs = { workType: 'architecture', size: 'M' } as const;
          const tier = policy
            ? (() => {
                const rule = policy.rule ?? loadTierRule(config.repoRoot);
                validateModelTierSupport(
                  policy,
                  config.operator.binaryPaths?.claude,
                  spec,
                  rule,
                  inputs,
                  ['claude'],
                  config.operator.executorLevels,
                  config.operator.executors?.claude?.configDir,
                );
                return admitModelTier(
                  spec,
                  rule,
                  policy,
                  inputs,
                  config.operator,
                  request.executionId,
                  authorityBlock,
                  availability,
                );
              })()
            : undefined;
          const admission = policy
            ? tier && {
                ...tier.selection,
                slot: tier.slot,
              }
            : withMachineAdmission(request.executionId, (owners) => {
                const invalid = authorityBlock();
                if (invalid) throw new Error(invalid);
                const snapshot = readSelectionSnapshot(config.operator);
                snapshot.availability = availability;
                const selection = selectExecutor(spec, loadModelPolicy(config.repoRoot), snapshot);
                const { choice, gate } = selection;
                return {
                  ...selection,
                  slot:
                    choice && gate.status !== 'wait'
                      ? acquireExecutorSlot(
                          choice.executor,
                          gate.concurrencyLimit,
                          owners[choice.executor],
                          snapshot.machinePolicy?.maxExecutions,
                        )
                      : undefined,
                };
              });
          if (
            !admission?.slot ||
            admission.gate.status === 'wait' ||
            admission.choice?.executor !== 'claude'
          ) {
            admission?.slot?.release();
            const gate = {
              status: 'wait',
              resetsAt: null,
              reason: admission?.gate.reason ?? 'Runtime admission busy',
            } as const;
            await lifecycle.wait(gate);
            throw new Error(`Tech Lead espera admisión (${gate.reason})`);
          }
          const { slot, choice } = admission;
          const execution = {
            project_id: store.projectId,
            key: request.executionId,
            task_key: lifecycle.task,
            agent_template_version: spec.metadata.version,
            agent_role: request.role,
            executor: choice.executor,
            model_id: choice.model ?? '',
            model_tier: tier?.selection.tier ?? null,
            model_effort: tier?.selection.choice?.effort ?? null,
            selection_reason: admission.reason,
            session_id: null,
            pid: null,
            started_at: new Date().toISOString(),
            system_prompt_hash: compiled.systemPromptHash,
            project_brain_sha: feature.git_sha,
            task_version: task.version,
            tool_policy_version: compiled.toolPolicyVersion,
          };
          const attributes: Record<string, string | number> = {};
          let closed = false;
          try {
            await store.createExecution(execution);
            if (cancelled) throw new Error('Tech Lead cancelled');
            await lifecycle.running(() => active?.cancel());
            const invalid = authorityBlock();
            if (invalid) throw new Error(invalid);
            slot.markLaunching('registered_wrapper');
            active = underlying.start({
              ...request,
              model: choice.model,
              effort: tier?.selection.choice?.effort,
              tier: tier?.selection.tier ?? undefined,
              selectionReason: admission.reason,
              registerProcess: async (pid) => {
                await store.setExecutionProcess(request.executionId, lifecycle.owner, pid);
                slot.setExecutionProcess(pid);
              },
              persistProcessClose: () => store.closeExecution(request.executionId, lifecycle.owner),
            });
            for await (const event of active.events) {
              if (event.type === 'started') {
                await store.setExecutionSession(request.executionId, event.sessionId);
                slot.setSession(event.sessionId);
              }
              if (event.type === 'telemetry' && event.observation.kind === 'prefix')
                attributes['softwareagents.prefix.hash'] = event.observation.hash;
              if (event.type === 'telemetry' && event.observation.kind === 'model')
                attributes['gen_ai.response.model'] = event.observation.model;
              if (event.type === 'usage') {
                attributes['gen_ai.usage.input_tokens'] = event.inputTokens;
                attributes['gen_ai.usage.output_tokens'] = event.outputTokens;
              }
              if (event.type === 'finished') {
                closed = true;
                await store.closeExecution(request.executionId, lifecycle.owner);
                const entry = usageEntry(
                  execution,
                  task,
                  attributes,
                  config.operator.telemetry?.prices,
                );
                entry.costUsd = event.costUsd ?? entry.costUsd;
                await store.recordUsage(entry);
              }
              yield event;
            }
          } finally {
            active?.cancel();
            if (!active || closed) {
              if (!active && store.getExecution(request.executionId))
                await store.closeExecution(request.executionId, lifecycle.owner);
              slot.release();
            } else await lifecycle.retainForRecovery();
          }
        })(),
      };
    },
  };
}
