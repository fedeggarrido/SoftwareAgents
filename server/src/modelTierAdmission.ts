import type { AgentSpec } from '../../core/src/agentSpec.js';
import type { ModelTierPolicy, TierRule } from '../../core/src/modelTier.js';
import type { ProjectOperatorConfig } from '../../core/src/project.js';
import type { SelectionSnapshot } from './executorSelection.js';
import { acquireExecutorSlot, withMachineAdmission } from './executorSlots.js';
import { selectModelTier, type TierInputs, type TierSelection } from './modelTiers.js';
import { readSelectionSnapshot } from './quotaCommand.js';

/** Fixed lock order across workers. Both gate observations and reservation stay
 * inside the existing admission locks, without changing slot ownership/lifetime. */
export function admitModelTier(
  agent: AgentSpec,
  rule: TierRule,
  policy: ModelTierPolicy,
  inputs: TierInputs,
  operator: ProjectOperatorConfig,
  executionId: string,
  /** Inside admission: why the Operator authority this run started with no longer holds (SA-088). */
  authorityBlock?: () => string | undefined,
  /** SA-090: probe facts observed by this process just before admission. */
  availability?: SelectionSnapshot['availability'],
) {
  return withMachineAdmission(executionId, (owners) => {
    const snapshot = readSelectionSnapshot(operator);
    if (availability) snapshot.availability = availability;
    const selection: TierSelection = selectModelTier(agent, rule, policy, inputs, snapshot);
    const blocked = authorityBlock?.();
    if (blocked) {
      // Decided from a policy that no longer holds: neither launch nor escalate it.
      delete selection.block;
      selection.gate = { status: 'wait', resetsAt: null, reason: blocked, cause: 'configuration' };
      return { selection, slot: undefined, snapshot };
    }
    const { choice, gate } = selection;
    if (!choice || gate.status === 'wait') return { selection, slot: undefined, snapshot };
    const slot = acquireExecutorSlot(
      choice.executor,
      gate.concurrencyLimit,
      owners[choice.executor],
      snapshot.machinePolicy?.maxExecutions,
    );
    if (!slot)
      selection.gate = {
        status: 'wait',
        resetsAt: null,
        reason: `${choice.executor}: no free runtime executor slot`,
        cause: 'concurrency',
      };
    return { selection, slot, snapshot };
  });
}
