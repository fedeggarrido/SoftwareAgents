import { spawn } from 'child_process';
import * as path from 'path';

import { OFFICE_OPEN_QUERY } from '../../core/src/constants.js';
import { OFFICE_BOOTSTRAP_BYTES } from './constants.js';
import { withoutOperatorToken } from './featureIngress.js';
import { featureIngressActor } from './featureIngress.js';

export function shouldOpenOffice(
  noOpen = false,
  stdinTTY = process.stdin.isTTY,
  stdoutTTY = process.stdout.isTTY,
  env = process.env,
): boolean {
  return (
    !noOpen &&
    !!stdinTTY &&
    !!stdoutTTY &&
    featureIngressActor() === 'human' &&
    !['CI', 'VITEST', 'PLAYWRIGHT', 'PIXEL_AGENTS_NO_OPEN'].some((key) => env[key] !== undefined) &&
    env.NODE_ENV !== 'test'
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
