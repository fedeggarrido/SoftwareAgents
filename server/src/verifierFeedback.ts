import * as path from 'path';

import { redactAudit } from './auditLog.js';
import {
  VERIFIER_FEEDBACK_FIELD_CHARS,
  VERIFIER_FEEDBACK_MAX_CHARS,
  VERIFIER_FEEDBACK_MAX_FILES,
  VERIFIER_FEEDBACK_MAX_LINES,
} from './constants.js';
import type { CriterionResult } from './evalCriteria.js';

export type VerifierKind = 'prettier' | 'eslint' | 'tsc' | 'tests' | 'e2e';
export interface VerifierFailure {
  verifier: VerifierKind;
  command: string[];
  files: string[];
  result: CriterionResult;
  detail: string;
}

export function verifierKind(argv: readonly string[]): VerifierKind {
  const names = argv.slice(0, 2).map((arg) => path.basename(arg).toLowerCase());
  if (names.some((name) => /^prettier(?:\.c?js)?$/.test(name))) return 'prettier';
  if (names.some((name) => /^eslint(?:\.js)?$/.test(name))) return 'eslint';
  if (names.some((name) => /^tsc(?:\.js)?$/.test(name))) return 'tsc';
  if (names.some((name) => name.includes('playwright'))) return 'e2e';
  return 'tests';
}

/** Strip terminal controls and redact before truncating (including secrets crossing chunks).
 * These diagnostics only enter the compiler's untrusted JSON data boundary. */
export function verifierFailure(
  verifier: VerifierKind,
  argv: readonly string[],
  files: readonly string[],
  result: CriterionResult,
  output: string,
  roots: readonly string[],
): VerifierFailure {
  const clean = (value: string) => {
    let safe = String(redactAudit(value))
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
      .replace(/\b((?:api[_-]?key|token|secret|password)\s*[:=]\s*)\S+/gi, '$1[REDACTED]');
    for (const root of roots.filter(Boolean).sort((a, b) => b.length - a.length)) {
      for (const variant of [root, root.replaceAll('\\', '/')])
        safe = safe.split(variant).join('<runtime>');
    }
    return safe
      .split('\n')
      .slice(0, VERIFIER_FEEDBACK_MAX_LINES)
      .join('\n')
      .slice(0, VERIFIER_FEEDBACK_MAX_CHARS);
  };
  return {
    verifier,
    command: argv
      .slice(0, VERIFIER_FEEDBACK_MAX_FILES)
      .map((value) => clean(value).slice(0, VERIFIER_FEEDBACK_FIELD_CHARS)),
    files: files
      .slice(0, VERIFIER_FEEDBACK_MAX_FILES)
      .map((value) => clean(value).slice(0, VERIFIER_FEEDBACK_FIELD_CHARS)),
    result,
    detail: clean(output || `Verifier exited with ${result}; no diagnostic output.`),
  };
}

export function styleOnlyFailures(failures: readonly VerifierFailure[]): boolean {
  return failures.length > 0 && failures.every((f) => ['prettier', 'eslint'].includes(f.verifier));
}

export function verifierFailureReason(failures: readonly VerifierFailure[]): string {
  return `verifier_failed: ${[...new Set(failures.map((f) => f.verifier))].join('|')}`;
}
