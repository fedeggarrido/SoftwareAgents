import { spawn } from 'child_process';
import * as path from 'path';

import { withoutOperatorToken } from './featureIngress.js';

/** The capability travels directly to the browser, outside stdout and logs. */
export function openOffice(url: string): void {
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
