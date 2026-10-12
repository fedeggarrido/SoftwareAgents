import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentSpec } from '../../core/src/agentSpec.js';
import type {
  ModelTier,
  ModelTierPolicy,
  TierCandidate,
  TierRule,
  WorkSize,
  WorkType,
} from '../../core/src/modelTier.js';
import {
  type CandidateExclusion,
  excludeCandidate,
  type SelectionBlock,
  selectionBlock,
  type SelectionSnapshot,
  unprovenWait,
} from './executorSelection.js';
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
    fallback: {
      type: 'object',
      additionalProperties: false,
      required: ['workType', 'size'],
      properties: { workType: { enum: WORK_TYPES }, size: { enum: ['S', 'M', 'L'] } },
    },
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

export class ModelTierConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelTierConfigError';
  }
}
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
/** Resolve the same executable for the support probe and the actual execution. */
export function resolveClaudeBinary(binary = 'claude'): string {
  const extensions = process.platform === 'win32' ? ['', '.exe'] : [''];
  const explicitPath = path.isAbsolute(binary) || /[\\/]/.test(binary);
  const directories = explicitPath
    ? ['']
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory.replace(/^"|"$/g, ''), binary + extension);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (!explicitPath) {
          // Executors launch native binaries without a shell, not npm's cmd/sh shims.
          if (process.platform === 'win32' && !candidate.toLowerCase().endsWith('.exe')) continue;
          if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        }
        return fs.realpathSync.native(candidate);
      } catch {
        /* Missing/inaccessible binary: support fails closed below. */
      }
    }
  }
  return binary;
}
const effortSupport = new Map<string, readonly string[]>();
/** No prompt, no shell, no repository cwd; cache successes and failures per resolved binary. */
export function claudeEffortSupported(binary = 'claude'): readonly string[] {
  binary = resolveClaudeBinary(binary);
  const cached = effortSupport.get(binary);
  if (cached) return cached;
  let supported: readonly string[] = [];
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
    supported = CLAUDE_EFFORTS.filter((e) => levels.includes(e));
  } catch {
    /* Unknown support fails closed, including on subsequent uses. */
  }
  effortSupport.set(binary, supported);
  return supported;
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
export function validateModelTiers(raw: unknown): ModelTierPolicy {
  try {
    const policy = validateSchema(validatePolicy, raw);
    if (!policy.tiers[policy.maxTier]) throw new Error('maxTier references an undefined tier');
    if (policy.rule) validateTierRule(policy.rule);
    for (const [tier, definition] of Object.entries(policy.tiers)) {
      if (
        definition.fallbackTo &&
        (!policy.tiers[definition.fallbackTo] ||
          MODEL_TIERS.indexOf(definition.fallbackTo) >= MODEL_TIERS.indexOf(tier as ModelTier))
      )
        throw new Error(`${tier}: fallbackTo must reference a defined lower tier`);
      for (const candidate of definition.candidates)
        validateModelChoice(candidate, candidate.executor, CLAUDE_EFFORTS);
    }
    return policy;
  } catch (error) {
    throw new ModelTierConfigError(`Invalid Operator modelTiers: ${(error as Error).message}`);
  }
}
/** Runtime validation only; config readers must never launch a CLI. */
export function validateModelTierSupport(
  policy: ModelTierPolicy,
  binary?: string,
  agent?: AgentSpec,
  rule?: TierRule,
  input: TierInputs = {},
  allowed: readonly string[] = ['claude', 'codex'],
): void {
  const reachable = new Set<ModelTier>();
  if (agent && rule) {
    let tier: ModelTier | undefined = initialModelTier(agent, rule, policy, input).tier;
    while (tier) {
      reachable.add(tier);
      tier = agent.modelPolicy.fallbackAllowed ? policy.tiers[tier]?.fallbackTo : undefined;
    }
  } else
    for (const tier of MODEL_TIERS.slice(0, MODEL_TIERS.indexOf(policy.maxTier) + 1))
      reachable.add(tier);
  for (const tier of reachable) {
    const definition = policy.tiers[tier];
    if (!definition) continue;
    for (const candidate of definition.candidates) {
      if (
        allowed.includes('claude') &&
        candidate.executor === 'claude' &&
        candidate.effort !== undefined
      )
        try {
          validateModelChoice(candidate, 'claude', claudeEffortSupported(binary));
        } catch (error) {
          throw new ModelTierConfigError(
            `Invalid Operator modelTiers: ${(error as Error).message} (${resolveClaudeBinary(binary)})`,
          );
        }
    }
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
  /** SA-090: candidates only the Operator can bring back, and whether that blocks. */
  exclusions?: CandidateExclusion[];
  block?: SelectionBlock;
}
function initialModelTier(
  agent: AgentSpec,
  rule: TierRule,
  policy: ModelTierPolicy,
  input: TierInputs,
) {
  const capability = agent.modelPolicy.capabilityClass;
  const base = Object.hasOwn(rule.capabilityWeights, capability)
    ? rule.capabilityWeights[capability]
    : undefined;
  const fallback = !input.workType || !input.size;
  if (base === undefined)
    throw new ModelTierConfigError(`modelTiers rule: missing capabilityClass ${capability}`);
  const effective = fallback ? (rule.fallback ?? { workType: 'implementation', size: 'M' }) : input;
  const score =
    base + rule.workTypeWeights[effective.workType!] + rule.sizeWeights[effective.size!];
  const requested =
    score === undefined
      ? null
      : [...MODEL_TIERS].reverse().find((t) => score >= rule.thresholds[t])!;
  const tier = requested
    ? MODEL_TIERS[Math.min(MODEL_TIERS.indexOf(requested), MODEL_TIERS.indexOf(policy.maxTier))]
    : null;
  const prefix = `${agent.identity.role} → ${capability}; ${fallback ? `fallback: missing or invalid work type/size, ${effective.workType}/${effective.size}` : `${input.workType}/${input.size}`}; score=${score}; requested=${requested}; maxTier=${policy.maxTier}`;
  return { tier: tier!, requested, prefix };
}
/** Deterministic and pure; every candidate sees exactly the same gate snapshot. */
export function selectModelTier(
  agent: AgentSpec,
  rule: TierRule,
  policy: ModelTierPolicy,
  input: TierInputs,
  snapshot: SelectionSnapshot,
): TierSelection {
  const { tier, requested, prefix } = initialModelTier(agent, rule, policy, input);
  const downgrades: ModelTier[] = [];
  const waits: Extract<QuotaDecision, { status: 'wait' }>[] = [];
  const reasons: string[] = [];
  const exclusions: CandidateExclusion[] = [];
  let candidates = 0;
  let current = tier;
  while (current) {
    const definition = policy.tiers[current];
    if (!definition) {
      reasons.push(`${current}: no_allowed_level (undefined tier)`);
      break;
    }
    let quotaBlocked = false;
    for (const choice of definition.candidates) {
      candidates++;
      const excluded = excludeCandidate(choice.executor, snapshot);
      if (excluded) {
        exclusions.push({ executor: choice.executor, tier: current, code: excluded });
        reasons.push(
          `${current}/${choice.executor}: ${excluded === 'operator_disabled' ? 'operator disabled' : excluded}`,
        );
        continue;
      }
      const gate =
        unprovenWait(choice.executor, snapshot) ??
        quotaGate(
          choice.executor,
          snapshot.machinePolicy,
          snapshot.capacities[choice.executor],
          snapshot.active[choice.executor] ?? NaN,
          snapshot.nowS,
          (snapshot.active.claude ?? 0) + (snapshot.active.codex ?? 0),
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
          exclusions,
        };
      waits.push(gate);
      quotaBlocked ||= gate.cause === 'quota';
    }
    if (!quotaBlocked || !agent.modelPolicy.fallbackAllowed || !definition.fallbackTo) break;
    current = definition.fallbackTo;
    downgrades.push(current);
  }
  const resets = waits.map((w) => w.resetsAt).filter((r): r is number => r !== null);
  const reason = `${prefix}; ${reasons.join('; ') || 'no_allowed_level: unknown capabilityClass'}`;
  const block = selectionBlock(candidates, waits.length > 0, exclusions);
  return {
    tier,
    requestedTier: requested,
    choice: null,
    downgrades,
    gate: {
      status: 'wait',
      resetsAt: resets.length ? Math.min(...resets) : null,
      reason,
      cause: waits.some((w) => w.cause === 'quota') ? 'quota' : (waits[0]?.cause ?? 'disabled'),
    },
    reason,
    exclusions,
    ...(block ? { block } : {}),
  };
}
