import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

import { taskPath } from './commands/taskFiles.js';
import { TASK_CLI_INPUT_BYTES } from './constants.js';
import { withoutOperatorToken } from './featureIngress.js';
import { HEXAGONAL_MARKER } from './projectArchitectureConstants.js';
import { projectQualityLintCommand } from './projectQualityLint.js';
import { type VerifierFailure,verifierFailure } from './verifierFeedback.js';

/** Recheck the reviewed SHA with the same isolated verifier, never a project's executable config. */
export function projectBoundaryFailures(root: string, files: string[]): VerifierFailure[] {
  if (!fs.existsSync(taskPath(root, HEXAGONAL_MARKER))) return [];
  const scripts = files.filter(
    (file) => /\.[cm]?[jt]sx?$/i.test(file) && fs.existsSync(taskPath(root, file)),
  );
  return projectQualityLintCommand(scripts).flatMap((command) => {
    if (!('argv' in command)) throw new Error('Expected managed lint command');
    const result = spawnSync(command.argv[0], command.argv.slice(1), {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: withoutOperatorToken(process.env),
      timeout: command.timeoutMs,
      maxBuffer: TASK_CLI_INPUT_BYTES,
    });
    if (result.error || result.status === null || result.status > 1)
      throw new Error('No se pudo verificar la arquitectura antes de la revisión.', {
        cause: result.error,
      });
    if (result.status === 0) return [];
    const failure = verifierFailure('eslint', command.argv, scripts, 'fail', result.stdout, [root]);
    return failure.boundaries?.length ? [failure] : [];
  });
}
