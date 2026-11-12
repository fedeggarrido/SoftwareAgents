import * as fs from 'fs';
import * as path from 'path';

import type { CascadeVerifier } from '../../core/src/modelTier.js';
import { EVAL_CRITERION_TIMEOUT_MS, PROJECT_QUALITY_LINT_CONFIG } from './constants.js';

/** Assets ship beside the CLI and resolve tooling from the runtime installation. */
export function projectQualityLintCommand(files: string[]): CascadeVerifier['commands'] {
  if (!files.length) return [];
  const bundled = path.join(__dirname, PROJECT_QUALITY_LINT_CONFIG);
  const config = fs.existsSync(bundled)
    ? bundled
    : path.resolve(__dirname, '../..', PROJECT_QUALITY_LINT_CONFIG);
  return [
    {
      argv: [
        process.execPath,
        path.join(path.dirname(require.resolve('eslint/package.json')), 'bin/eslint.js'),
        '--no-cache',
        '--no-config-lookup',
        '--no-ignore',
        '--no-inline-config',
        '--config',
        config,
        '--',
        ...files,
      ],
      timeoutMs: EVAL_CRITERION_TIMEOUT_MS,
    },
  ];
}
