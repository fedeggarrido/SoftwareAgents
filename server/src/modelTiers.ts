import { execFileSync } from 'child_process';
import * as os from 'os';

import type { AgentSpec } from '../../core/src/agentSpec.js';
import type {
  ModelTier,
  ModelTierPolicy,
  TierCandidate,
  TierRule,
  WorkSize,
  WorkType,
} from '../../core/src/modelTier.js';
import type { SelectionSnapshot } from './executorSelection.js';
import { type QuotaDecision, quotaGate } from './quotaGate.js';
import { compileSchema, validateSchema } from './schemaValidation.js';

export const MODEL_TIERS = ['economy', 'standard', 'deep'] as const;
export const WORK_TYPES = [
  'summary',
  'classification',
  'docs',
  'implementation',
  'review',
  'qa',
  'architecture',
] as const;
// Codex 0.160.0 generated ReasoningEffort schema accepts nonempty strings. We
// deliberately expose only these bounded values, never arbitrary TOML content.
export const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const weight = { type: 'integer', minimum: 0, maximum: 1000 };
const weights = (keys: readonly string[]) => ({
  type: 'object',
  additionalProperties: false,
  required: keys,
  properties: Object.fromEntries(keys.map((k) => [k, weight])),
});
export const tierRuleSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['capabilityWeights', 'workTypeWeights', 'sizeWeights', 'thresholds'],
  properties: {
    capabilityWeights: {
      type: 'object',
      minProperties: 1,
      additionalProperties: weight,
      propertyNames: { pattern: '^[a-z][a-z0-9_]*$' },
    },
    workTypeWeights: weights(WORK_TYPES),
    sizeWeights: weights(['S', 'M', 'L']),
    thresholds: weights(MODEL_TIERS),
  },
};
const validateRule = compileSchema<TierRule>(tierRuleSchema);
export const tierPolicySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['maxTier', 'tiers'],
  properties: {
    maxTier: { enum: MODEL_TIERS },
    rule: tierRuleSchema,
    tiers: {
      type: 'object',
      minProperties: 1,
      additionalProperties: false,
      properties: Object.fromEntries(
        MODEL_TIERS.map((t) => [
          t,
          {
            type: 'object',
            additionalProperties: false,
            required: ['candidates'],
            properties: {
              fallbackTo: { enum: MODEL_TIERS },
              candidates: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['executor', 'model'],
                  properties: {
                    executor: { enum: ['claude', 'codex'] },
                    model: {
                      type: 'string',
                      maxLength: 128,
                      pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:/-]*(?![\\s\\S])',
                    },
                    effort: { enum: [...new Set([...CODEX_EFFORTS, ...CLAUDE_EFFORTS])] },
                  },
                },
              },
            },
          },
        ]),
      ),
    },
  },
};
const validatePolicy = compileSchema<ModelTierPolicy>(tierPolicySchema);

export class ModelTierConfigError extends Error {}
export function validateTierRule(raw: unknown): TierRule {
  const rule = validateSchema(validateRule, raw);
  if (
    rule.thresholds.economy !== 0 ||
    rule.thresholds.standard <= 0 ||
    rule.thresholds.deep <= rule.thresholds.standard
  )
    throw new ModelTierConfigError(
      'modelTiers rule: thresholds must be economy=0 < standard < deep',
    );
  return rule;
}
/** No prompt, no shell, no repository cwd, bounded output; unknown support fails closed. */
export function claudeEffortSupported(binary = 'claude'): readonly string[] {
  try {
    const help = execFileSync(binary, ['--help'], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const levels =
      /--effort\s+<level>[^()]*\(([^)]+)\)/
        .exec(help)?.[1]
        ?.split(',')
        .map((s) => s.trim()) ?? [];
    return CLAUDE_EFFORTS.filter((e) => levels.includes(e));
  } catch {
    return [];
  }
}
export function validateModelChoice(
  choice: Partial<Pick<TierCandidate, 'model' | 'effort'>>,
  executor: 'claude' | 'codex',
  supported: readonly string[] = [],
): void {
  if (
    choice.model !== undefined &&
    (typeof choice.model !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}(?![\s\S])/.test(choice.model))
  )
    throw new ModelTierConfigError('Invalid model identifier');
  if (
    choice.effort !== undefined &&
    !(executor === 'codex' ? CODEX_EFFORTS : supported).includes(choice.effort)
  )
    throw new ModelTierConfigError(`Invalid or unsupported ${executor} effort`);
}
export function validateModelTiers(
  raw: unknown,
  probe: () => readonly string[] = () => claudeEffortSupported(),
): ModelTierPolicy {
  try {
    const policy = validateSchema(validatePolicy, raw);
    if (!policy.tiers[policy.maxTier]) throw new Error('maxTier references an undefined tier');
    if (policy.rule) validateTierRule(policy.rule);
    const needsClaude = Object.values(policy.tiers).some((t) =>
      t.candidates.some((c) => c.executor === 'claude' && c.effort !== undefined),
    );
    const supported = needsClaude ? probe() : [];
    for (const [tier, definition] of Object.entries(policy.tiers)) {
      if (
        definition.fallbackTo &&
        (!policy.tiers[definition.fallbackTo] ||
          MODEL_TIERS.indexOf(definition.fallbackTo) >= MODEL_TIERS.indexOf(tier as ModelTier))
      )
        throw new Error(`${tier}: fallbackTo must reference a defined lower tier`);
      for (const candidate of definition.candidates)
        validateModelChoice(candidate, candidate.executor, supported);
    }
    return policy;
  } catch (error) {
    throw new ModelTierConfigError(`Invalid Operator modelTiers: ${(error as Error).message}`);
  }
}
export interface TierInputs {
  workType?: WorkType;
  size?: WorkSize;
}
export interface TierSelection {
  tier: ModelTier | null;
  requestedTier: ModelTier | null;
  choice: TierCandidate | null;
  downgrades: ModelTier[];
  gate: QuotaDecision;
  reason: string;
}
/** Deterministic and pure; every candidate sees exactly the same gate snapshot. */
export function selectModelTier(
  agent: AgentSpec,
  rule: TierRule,
  policy: ModelTierPolicy,
  input: TierInputs,
  snapshot: SelectionSnapshot,
): TierSelection {
  const capability = agent.modelPolicy.capabilityClass;
  const base = Object.hasOwn(rule.capabilityWeights, capability)
    ? rule.capabilityWeights[capability]
    : undefined;
  const fallback = !input.workType || !input.size;
  const score =
    base === undefined
      ? undefined
      : base +
        (fallback ? 0 : rule.workTypeWeights[input.workType!] + rule.sizeWeights[input.size!]);
  const requested =
    score === undefined
      ? null
      : [...MODEL_TIERS].reverse().find((t) => score >= rule.thresholds[t])!;
  const tier = requested
    ? MODEL_TIERS[Math.min(MODEL_TIERS.indexOf(requested), MODEL_TIERS.indexOf(policy.maxTier))]
    : null;
  const prefix = `${agent.identity.role} → ${capability}; ${fallback ? 'fallback: missing work type/size, capabilityClass only' : `${input.workType}/${input.size}`}; score=${score ?? 'unknown'}; requested=${requested}; maxTier=${policy.maxTier}`;
  const downgrades: ModelTier[] = [];
  const waits: Extract<QuotaDecision, { status: 'wait' }>[] = [];
  const reasons: string[] = [];
  let current = tier;
  while (current) {
    const definition = policy.tiers[current];
    if (!definition) {
      reasons.push(`${current}: no_allowed_level (undefined tier)`);
      break;
    }
    let quotaBlocked = false;
    for (const choice of definition.candidates) {
      if (!snapshot.allowedExecutors.includes(choice.executor)) {
        reasons.push(`${current}/${choice.executor}: operator disabled`);
        continue;
      }
      const gate = quotaGate(
        choice.executor,
        snapshot.machinePolicy,
        snapshot.capacities[choice.executor],
        snapshot.active[choice.executor] ?? NaN,
        snapshot.nowS,
      );
      reasons.push(`${current}/${choice.executor}: ${gate.reason}`);
      if (gate.status !== 'wait')
        return {
          tier: current,
          requestedTier: requested,
          choice,
          downgrades,
          gate,
          reason: `${prefix}; ${reasons.join('; ')}`,
        };
      waits.push(gate);
      quotaBlocked ||= /remaining quota below|capacity rejected/.test(gate.reason);
    }
    if (!quotaBlocked || !agent.modelPolicy.fallbackAllowed || !definition.fallbackTo) break;
    current = definition.fallbackTo;
    downgrades.push(current);
  }
  const resets = waits.map((w) => w.resetsAt).filter((r): r is number => r !== null);
  const reason = `${prefix}; ${reasons.join('; ') || 'no_allowed_level: unknown capabilityClass'}`;
  return {
    tier,
    requestedTier: requested,
    choice: null,
    downgrades,
    gate: { status: 'wait', resetsAt: resets.length ? Math.min(...resets) : null, reason },
    reason,
  };
}
