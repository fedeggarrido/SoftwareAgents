import * as fs from 'fs';

import { CliUsageError } from './cliErrors.js';
import {
  MAX_PORT,
  MIN_PORT,
  SERVER_JSON_NAME,
  SERVERS_DIR,
  TOKEN_ROTATE_REQUEST_TIMEOUT_MS,
} from './constants.js';
import { discoveryEntryPath, discoveryPath } from './discoveryRecords.js';
import { isServerTarget } from './serverConfig.js';
import { probeServer } from './serverProbe.js';

export async function runTokenCommand(argv: string[], log = console.log): Promise<void> {
  if (
    argv[0] !== 'rotate' ||
    (argv.length !== 1 && !(argv.length === 3 && argv[1] === '--port' && /^\d+$/.test(argv[2])))
  )
    throw new CliUsageError('Usage: pixel-agents token rotate [--port PORT]');
  const port = argv[2] ? Number(argv[2]) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT))
    throw new CliUsageError('Invalid server port');
  const files =
    port === undefined
      ? [SERVER_JSON_NAME]
      : fs
          .readdirSync(discoveryPath(SERVERS_DIR))
          .filter((file) => file.endsWith('.json'))
          .map((file) => `${SERVERS_DIR}/${file}`);
  const targets = files.flatMap((file) => {
    try {
      const target: unknown = JSON.parse(fs.readFileSync(discoveryEntryPath(file), 'utf8'));
      return isServerTarget(target) && (port === undefined || target.port === port) ? [target] : [];
    } catch {
      return [];
    }
  });
  if (targets.length !== 1 || (await probeServer(targets[0])) !== 'healthy')
    throw new CliUsageError('No unique healthy server found; select --port PORT');
  const target = targets[0];
  const host = target.host ?? '127.0.0.1';
  const response = await fetch(
    `http://${host.includes(':') ? `[${host}]` : host}:${target.port}/api/token/rotate`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${target.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(TOKEN_ROTATE_REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error(`Token rotation failed (${response.status})`);
  log(
    `Token rotated on port ${target.port}. Reopen the office using discovery; existing sockets were disconnected.`,
  );
}
