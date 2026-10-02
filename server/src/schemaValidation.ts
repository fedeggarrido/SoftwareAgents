import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';
import Ajv from 'ajv';

/** No coercion, default insertion or removal of unknown properties. */
const ajv = new Ajv({ allErrors: true, strict: true });

export class SchemaValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join('\n'));
    this.name = 'SchemaValidationError';
  }
}

function formatError(error: ErrorObject): string {
  const field =
    error.keyword === 'required'
      ? error.params.missingProperty
      : error.keyword === 'additionalProperties'
        ? error.params.additionalProperty
        : undefined;
  const location = `${error.instancePath}${field === undefined ? '' : `/${field}`}`;
  return `${location || '/'}: ${error.message ?? 'invalid value'}`;
}

export function compileSchema<T>(schema: AnySchema): ValidateFunction<T> {
  return ajv.compile<T>(schema);
}

export function validateSchema<T>(validate: ValidateFunction<T>, value: unknown): T {
  if (!validate(value)) {
    throw new SchemaValidationError((validate.errors ?? []).map(formatError));
  }
  return value;
}
