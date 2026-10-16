import * as fs from 'fs';
import { parseDocument } from 'yaml';

import * as featureSchema from '../../core/schemas/feature-spec.schema.json';
import type { FeatureSpec } from '../../core/src/featureSpec.js';
import { compileSchema, SchemaValidationError, validateSchema } from './schemaValidation.js';

const validateFeature = compileSchema<FeatureSpec>(featureSchema);

/** Reads an explicitly selected file only. Project-scoped callers must enforce path containment. */
export function loadFeatureSpec(file: string): FeatureSpec {
  const source = fs.readFileSync(file, 'utf8');
  return parseFeatureSpec(source, file);
}

/** Parse a caller-supplied, bounded snapshot using the same FeatureSpec validation. */
export function parseFeatureSpec(source: string, file: string): FeatureSpec {
  try {
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length) {
      throw new SchemaValidationError(document.errors.map((error) => `/: ${error.message}`));
    }
    let value: unknown;
    try {
      value = document.toJS({ maxAliasCount: 100 });
    } catch (error) {
      throw new SchemaValidationError([`/: ${(error as Error).message}`]);
    }
    return validateSchema(validateFeature, value);
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new SchemaValidationError(error.errors.map((message) => `${file}: ${message}`));
    }
    throw error;
  }
}
