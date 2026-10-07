import { isIP } from 'net';
import * as os from 'os';

import { MAX_PORT, MIN_PORT, SERVER_REGISTRY_PROTOCOL_VERSION } from './constants.js';

/** Minimum fields the hook producer needs to contact a server. Kept separate
 *  from ServerConfig so the new hook script can still reach an old server via
 *  the legacy server.json record during the mixed-version compatibility window. */
export interface ServerTarget {
  port: number;
  pid: number;
  token: string;
  /** Literal IP on this machine; absent in old records means 127.0.0.1. */
  host?: string;
  startedAt?: number;
  debugLog?: string;
}

/** Complete per-server discovery record stored in the multi-server registry. */
export interface ServerConfig extends ServerTarget {
  /** Timestamp (ms) when the server started. */
  startedAt: number;
  /** Whether this server serves the webview SPA (standalone / !embedded). */
  servesSpa: boolean;
  /** Registry record format version. */
  protocol: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** No DNS names, remote addresses, or wildcard addresses as contact targets. */
export function isLocalContactHost(host: unknown): host is string {
  if (typeof host !== 'string' || !isIP(host)) return false;
  if (host === '0.0.0.0' || host === '::') return false;
  if (host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))) return true;
  return Object.values(os.networkInterfaces()).some((entries) =>
    entries?.some((entry) => entry.address === host),
  );
}

/** Validate the contact fields shared by current and legacy discovery records. */
export function isServerTarget(value: unknown): value is ServerTarget {
  return (
    isServerTargetStructure(value) && (value.host === undefined || isLocalContactHost(value.host))
  );
}

/** Shape only: temporarily missing interfaces must not trigger deletion. */
export function isServerTargetStructure(value: unknown): value is ServerTarget {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.port) &&
    (value.port as number) >= MIN_PORT &&
    (value.port as number) <= MAX_PORT &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    typeof value.token === 'string' &&
    value.token.length > 0 &&
    (value.host === undefined || (typeof value.host === 'string' && !!isIP(value.host))) &&
    (value.startedAt === undefined ||
      (Number.isSafeInteger(value.startedAt) && (value.startedAt as number) >= 0)) &&
    (value.debugLog === undefined || typeof value.debugLog === 'string')
  );
}

/** Validate a complete current-version registry record before reuse/fan-out. */
export function isServerConfig(value: unknown): value is ServerConfig {
  return isServerConfigStructure(value) && isServerTarget(value);
}

export function isServerConfigStructure(value: unknown): value is ServerConfig {
  if (!isServerTargetStructure(value) || !isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.startedAt) &&
    (value.startedAt as number) >= 0 &&
    typeof value.servesSpa === 'boolean' &&
    value.protocol === SERVER_REGISTRY_PROTOCOL_VERSION
  );
}
