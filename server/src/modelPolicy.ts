import * as fs from 'fs';
import { parseDocument } from 'yaml';

import type { TierRule } from '../../core/src/modelTier.js';
import type { ModelPolicy } from './executorSelection.js';
import { validateTierRule } from './modelTiers.js';
import { resolveInside } from './pathGuard.js';
import { compileSchema, SchemaValidationError, validateSchema } from './schemaValidation.js';

const validate = compileSchema<ModelPolicy>({
  type: 'object',
  additionalProperties: false,
  properties: Object.fromEntries(
    ['high_reasoning', 'standard_coding', 'fast_cheap', 'review'].map((key) => [
      key,
      {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['executor'],
          properties: {
            executor: { enum: ['claude', 'codex'] },
          },
        },
      },
    ]),
  ),
});

/** Protected Project Brain preferences. No permissions, thresholds or limits accepted. */
function readPolicy(root: string): Record<string, unknown> {
  const document = parseDocument(
    fs.readFileSync(resolveInside(root, '.softwareagents/agents/model-policy.yaml'), 'utf8'),
    { uniqueKeys: true },
  );
  if (document.errors.length)
    throw new SchemaValidationError(document.errors.map((e) => e.message));
  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    throw new SchemaValidationError([(error as Error).message]);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new SchemaValidationError(['Invalid model policy']);
  return raw as Record<string, unknown>;
}
export function loadModelPolicy(root: string): ModelPolicy {
  const raw = readPolicy(root);
  const { tierRule, ...legacy } = raw;
  if (tierRule !== undefined) validateTierRule(tierRule);
  return validateSchema(validate, legacy);
}
export function loadTierRule(root: string): TierRule {
  const raw = readPolicy(root);
  const { tierRule, ...legacy } = raw;
  validateSchema(validate, legacy);
  return validateTierRule(tierRule);
}
