import * as contract from '../../core/schemas/design-report.schema.json';
import type { DesignReport, DesignValidation } from '../../core/src/designReport.js';
import { TASK_CLI_INPUT_BYTES } from './constants.js';
import { compileSchema, SchemaValidationError, validateSchema } from './schemaValidation.js';

const validator = compileSchema<DesignReport>(contract);
export function validateDesignReport(source: string, runtime: DesignValidation[]): DesignReport {
  if (Buffer.byteLength(source) > TASK_CLI_INPUT_BYTES)
    throw new SchemaValidationError(['DesignReport exceeds 1 MiB']);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new SchemaValidationError(['Designer must return JSON']);
  }
  const report = validateSchema(validator, value);
  const errors: string[] = [];
  if (
    report.verdict === 'approve' &&
    report.findings.some((f) => ['blocker', 'major'].includes(f.severity))
  )
    errors.push('blocker/major prohibits approve');
  if (JSON.stringify(report.validations) !== JSON.stringify(runtime))
    errors.push('Validations must exactly match runtime evidence');
  if (
    !runtime.some((v) => v.kind === 'capture' && v.result === 'pass') ||
    !runtime.some(
      (v) => v.kind === 'contrast' && v.evidence.trim() && v.tool === 'playwright-wcag/v1',
    )
  )
    errors.push('Real capture and runtime contrast evidence required');
  if (report.verdict === 'approve' && runtime.some((v) => v.result === 'fail'))
    errors.push('Failed runtime validation prohibits approve');
  if (errors.length) throw new SchemaValidationError(errors);
  return report;
}

/** WCAG relative luminance, sRGB channels in [0,255]. */
export function contrastRatio(a: readonly number[], b: readonly number[]): number {
  const luminance = (rgb: readonly number[]) => {
    if (rgb.length !== 3 || rgb.some((v) => !Number.isFinite(v) || v < 0 || v > 255))
      throw new Error('Invalid sRGB');
    const linear = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
