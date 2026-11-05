import type { ResearchMode, ResearchOperatorConfig } from '../../core/src/research.js';
import {
  RESEARCH_LIMITS,
  RESEARCH_MODE_DEFAULTS,
  RESEARCH_PRICE_TOKENS,
  RESEARCH_PRICES,
} from './constants.js';

export const researchLimitSchema = {
  type: 'object',
  additionalProperties: false,
  properties: Object.fromEntries(
    Object.entries(RESEARCH_LIMITS).map(([name, maximum]) => [
      name,
      { type: name === 'maxCostUsd' ? 'number' : 'integer', exclusiveMinimum: 0, maximum },
    ]),
  ),
};

export function researchPolicy(mode: ResearchMode, config: ResearchOperatorConfig = {}) {
  const limits = { ...RESEARCH_MODE_DEFAULTS[mode], ...config.modes?.[mode] };
  // Legacy per-project ceilings continue to narrow either mode.
  for (const name of Object.keys(RESEARCH_LIMITS) as (keyof typeof RESEARCH_LIMITS)[]) {
    const value = config[name];
    if (value !== undefined) limits[name] = Math.min(limits[name], value);
    if (
      !Number.isFinite(limits[name]) ||
      limits[name] <= 0 ||
      limits[name] > RESEARCH_LIMITS[name] ||
      (name !== 'maxCostUsd' && !Number.isInteger(limits[name])) ||
      (value !== undefined &&
        (!Number.isFinite(value) ||
          value <= 0 ||
          value > RESEARCH_LIMITS[name] ||
          (name !== 'maxCostUsd' && !Number.isInteger(value))))
    )
      throw new Error('Invalid research budgets');
  }
  return { ...limits, search: config.search, reddit: config.reddit };
}

export function researchCost(input: number, output: number): number {
  if (![input, output].every((value) => Number.isFinite(value) && value >= 0))
    throw new Error('Invalid research usage');
  return (input * RESEARCH_PRICES.input + output * RESEARCH_PRICES.output) / RESEARCH_PRICE_TOKENS;
}

/** Confirm the entire token budget at the higher output rate. */
export function researchEstimate(maxTokens: number): number {
  return researchCost(0, maxTokens);
}

export function researchCostConfirmation(estimateUsd: number, capUsd: number): string {
  return `${estimateUsd},${capUsd}`;
}

/** Deadline applies even to an adapter/iterator that ignores its AbortSignal. */
export async function researchDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error('Research budget exhausted'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
