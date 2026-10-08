import { ModelTierConfigError } from './modelTiers.js';
import { SchemaValidationError } from './schemaValidation.js';

/** Expected argument/project configuration failure, distinct from runtime bugs. */
export class CliUsageError extends Error {}

export function cliErrorOutput(error: unknown): unknown {
  return error instanceof CliUsageError ||
    error instanceof ModelTierConfigError ||
    error instanceof SchemaValidationError
    ? error.message
    : error;
}
