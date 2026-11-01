import { createHash, timingSafeEqual } from 'crypto';
import * as fs from 'fs';

import { CliUsageError } from './cliErrors.js';
import { SERVER_JSON_NAME } from './constants.js';
import { discoveryEntryPath, isProcessRunning } from './discoveryRecords.js';
import type { PolicyActor } from './policy.js';
import { isServerTarget } from './serverConfig.js';

export const OPERATOR_TOKEN_ENV = 'PIXEL_AGENTS_OPERATOR_TOKEN';

/** Strip after merging overrides too; Windows environment names are case insensitive. */
export function withoutOperatorToken(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toUpperCase() !== OPERATOR_TOKEN_ENV),
  );
}

const confirmationError =
  'Human confirmation requires the current server token: set PIXEL_AGENTS_OPERATOR_TOKEN in the operator environment or append --confirm for a hidden TTY prompt. Open the project office first.';

/** No network, logging, argv credentials or fallback to an inferred human identity. */
export async function confirmHumanIngress(argv: string[]): Promise<string[]> {
  if (featureIngressActor() !== 'human')
    throw new CliUsageError(
      'human ingress requires the human operator; managed agents cannot confirm',
    );
  const interactive = argv.at(-1) === '--confirm';
  const args = interactive ? argv.slice(0, -1) : argv;
  const supplied =
    process.env[OPERATOR_TOKEN_ENV] || (interactive ? await readOperatorToken() : '');
  if (!supplied) throw new CliUsageError(confirmationError);
  let expected: string;
  try {
    const target: unknown = JSON.parse(
      fs.readFileSync(discoveryEntryPath(SERVER_JSON_NAME), 'utf8'),
    );
    if (!isServerTarget(target) || !isProcessRunning(target.pid)) throw new Error();
    expected = target.token;
  } catch {
    throw new CliUsageError(confirmationError);
  }
  // Fixed-size digests keep comparison constant-time even for different input lengths.
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(supplied), digest(expected)))
    throw new CliUsageError('Invalid operator token; reopen discovery after token rotation.');
  return args;
}

export function readOperatorToken(input = process.stdin, output = process.stderr): Promise<string> {
  if (!input.isTTY || !output.isTTY || input.isRaw)
    throw new CliUsageError('Hidden confirmation requires a TTY; use PIXEL_AGENTS_OPERATOR_TOKEN.');
  return new Promise((resolve, reject) => {
    let token = '';
    const wasPaused = input.readableFlowing !== true;
    const finish = (error?: Error) => {
      input.off('data', data);
      input.off('end', ended);
      input.off('error', failed);
      input.setRawMode(false);
      if (wasPaused) input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(token);
      token = '';
    };
    const ended = () => finish(new CliUsageError('Operator confirmation cancelled'));
    const failed = () => ended();
    const data = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003' || char === '\u0004') return ended();
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') token = token.slice(0, -1);
        else token += char;
      }
    };
    output.write('Operator server token (hidden): ');
    input.setRawMode(true);
    input.on('data', data);
    input.once('end', ended);
    input.once('error', failed);
    input.resume();
  });
}

export function featureIngressActor(actor: PolicyActor = 'human'): PolicyActor {
  return ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'].some(
    (key) => process.env[key] !== undefined,
  )
    ? 'agent'
    : actor;
}
