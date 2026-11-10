import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { OFFICE_OPEN_PATH, OFFICE_OPEN_QUERY } from '../../core/src/constants.js';
import { CliUsageError } from './cliErrors.js';
import {
  OFFICE_BOOTSTRAP_BYTES,
  SERVER_JSON_NAME,
  TOKEN_ROTATE_REQUEST_TIMEOUT_MS,
} from './constants.js';
import { discoveryEntryPath, isProcessRunning } from './discoveryRecords.js';
import { featureIngressActor, withoutOperatorToken } from './featureIngress.js';
import { isServerTarget, type ServerTarget } from './serverConfig.js';
import { verifyServerProof } from './serverProof.js';

/** The endpoint only accepts loopback; never send the token to an advertised host. */
export async function requestOfficeOpenUrl(target: ServerTarget): Promise<string> {
  const origin = `http://127.0.0.1:${target.port}`;
  const response = await fetch(`${origin}${OFFICE_OPEN_PATH}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${target.token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(TOKEN_ROTATE_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('Office unavailable');
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== 'object' ||
    !('code' in body) ||
    typeof body.code !== 'string' ||
    !new RegExp(`^[a-f0-9]{${OFFICE_BOOTSTRAP_BYTES * 2}}$`).test(body.code) ||
    body.code === target.token
  )
    throw new Error('Office unavailable');
  return `${origin}/?${OFFICE_OPEN_QUERY}=${body.code}`;
}

function printOfficeLink(url: string, log: (message: string) => void): void {
  log(`Acceso de operador (un solo uso, caduca en 60 s): ${url}`);
  log('Si caduca: pixel-agents open');
}

export async function runOpenCommand(argv: string[], log = console.log): Promise<void> {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--no-open'))
    throw new CliUsageError('Uso: pixel-agents open [--no-open]');
  if (featureIngressActor() !== 'human')
    throw new CliUsageError(
      'El acceso de operador requiere una terminal humana; no se permite desde procesos gestionados.',
    );
  try {
    const target: unknown = JSON.parse(
      fs.readFileSync(discoveryEntryPath(SERVER_JSON_NAME), 'utf8'),
    );
    if (
      !isServerTarget(target) ||
      !isProcessRunning(target.pid) ||
      !(await verifyServerProof(target))
    )
      throw new Error();
    const url = await requestOfficeOpenUrl(target);
    if (shouldOpenOffice(argv[0] === '--no-open')) openOffice(url);
    else printOfficeLink(url, log);
  } catch {
    // Network/process errors can include credentials. Only emit content-free guidance.
    throw new CliUsageError(
      'No se pudo obtener acceso de operador. Comprueba que la oficina esté abierta desde una terminal humana.',
    );
  }
}

/** Only an interactive human startup may print a capability into its terminal. */
export async function presentOfficeAccess(
  getUrl: () => Promise<string>,
  noOpen = false,
  log = console.log,
): Promise<void> {
  if (!interactiveHumanStart()) return;
  const url = await getUrl();
  if (shouldOpenOffice(noOpen)) openOffice(url);
  else printOfficeLink(url, log);
}

function interactiveHumanStart(
  stdinTTY = process.stdin.isTTY,
  stdoutTTY = process.stdout.isTTY,
  env = process.env,
): boolean {
  return (
    !!stdinTTY &&
    !!stdoutTTY &&
    featureIngressActor() === 'human' &&
    !['CI', 'VITEST', 'PLAYWRIGHT'].some((key) => env[key] !== undefined) &&
    env.NODE_ENV !== 'test'
  );
}

export function shouldOpenOffice(
  noOpen = false,
  stdinTTY = process.stdin.isTTY,
  stdoutTTY = process.stdout.isTTY,
  env = process.env,
): boolean {
  return (
    !noOpen &&
    interactiveHumanStart(stdinTTY, stdoutTTY, env) &&
    env.PIXEL_AGENTS_NO_OPEN === undefined
  );
}

/** Only the short-lived bootstrap travels to the browser, outside stdout and logs. */
export function openOffice(url: string): void {
  // Defense in depth: this entry point only accepts the short-lived bootstrap URL.
  const parsed = new URL(url);
  if (
    parsed.searchParams.size !== 1 ||
    parsed.pathname !== '/' ||
    !!parsed.hash ||
    !!parsed.username ||
    !!parsed.password ||
    !new RegExp(`^[a-f0-9]{${OFFICE_BOOTSTRAP_BYTES * 2}}$`).test(
      parsed.searchParams.get(OFFICE_OPEN_QUERY) ?? '',
    )
  )
    return;
  const command =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe')
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const failed = () => console.error('No se pudo abrir Pixel Agents en el navegador.');
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: withoutOperatorToken(process.env),
    });
    child.on('error', failed);
    child.unref();
  } catch {
    // Spawn errors may include argv. Never let a capability-bearing error reach logs.
    failed();
  }
}
