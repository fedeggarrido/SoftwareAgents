import * as fs from 'fs';
import { parseDocument } from 'yaml';

import type { ModelPolicy } from './executorSelection.js';
import { resolveInside } from './pathGuard.js';
import { compileSchema, validateSchema } from './schemaValidation.js';

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
            model: { type: 'string', minLength: 1, pattern: '^[a-zA-Z0-9._:/-]+$' },
          },
        },
      },
    ]),
  ),
});

/** Protected Project Brain preferences. No permissions, thresholds or limits accepted. */
export function loadModelPolicy(root: string): ModelPolicy {
  const document = parseDocument(
    fs.readFileSync(resolveInside(root, '.softwareagents/agents/model-policy.yaml'), 'utf8'),
    { uniqueKeys: true },
  );
  if (document.errors.length) throw new Error(document.errors.map((e) => e.message).join('\n'));
  return validateSchema(validate, document.toJS({ maxAliasCount: 100 }));
}
