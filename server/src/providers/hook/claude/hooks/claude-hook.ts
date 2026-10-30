import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import {
  HOOK_API_PREFIX,
  HOOK_LEGACY_PROBE_TIMEOUT_MS,
  SERVER_JSON_DIR,
  SERVER_JSON_NAME,
  SERVERS_DIR,
} from '../../../../constants.js';
import { sameServerGeneration } from '../../../../discoveryRecords.js';
import type { ServerConfig, ServerTarget } from '../../../../serverConfig.js';
import { isServerConfig, isServerTarget } from '../../../../serverConfig.js';
import { probeServer } from '../../../../serverProbe.js';
import { hookBody } from './hookBody.js';

const SERVER_JSON = path.join(os.homedir(), SERVER_JSON_DIR, SERVER_JSON_NAME);
const SERVERS_REGISTRY_DIR = path.join(os.homedir(), SERVER_JSON_DIR, SERVERS_DIR);

/**
 * CI / e2e diagnostic: when PIXEL_AGENTS_DEBUG_LOG is set, record the hook
 * script's outcome at every exit point. The hook delivery chain (spawn
 * claude-hook.js -> read the registry -> POST to every live server) is
 * otherwise 100% silent: every failure path resolves quietly, so a dropped
 * hook is invisible in CI. Logging here lets a failing run show exactly
 * where delivery dies (bad-stdin, no-server-json, per-server POST
 * error/timeout/status). Zero cost when the env var is unset.
 */
// Env var is the primary source, but it doesn't reliably reach this spawned
// process across platforms (macOS VS Code terminal profiles with
// inheritEnv:false, etc.). After reading the registry we fall back to a
// live server's `debugLog` field, which the server populated from the same
// env var.
let debugLogPath = process.env['PIXEL_AGENTS_DEBUG_LOG'];
function hookDebug(line: string): void {
  if (!debugLogPath) return;
  try {
    fs.appendFileSync(debugLogPath, `${new Date().toISOString()} HOOKSCRIPT ${line}\n`);
  } catch {
    /* never let diagnostics break the hook */
  }
}

/** PID life only: registry fan-out does not authenticate the listener. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = alive but not ours to signal (an elevated VS Code with Claude Code in a normal
    // terminal); only ESRCH means gone. Same rule as the server's isProcessRunning.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Enumerate every live registry entry under ~/.pixel-agents/servers/, so the
 * event can fan out to each running server (VS Code embedded + a standalone
 * `npx pixel-agents`, or several of either, all at once). Entries whose owning
 * PID is no longer alive are skipped (the owning server prunes its own stale
 * file on next start; this script only needs to not POST to it). Returns an
 * empty array when the directory is absent/empty/unreadable -- the caller
 * falls back to the legacy single-target server.json (forward-compat with a
 * server that predates the registry).
 */
function readRegistry(dead: ServerTarget[]): ServerConfig[] {
  let files: string[];
  try {
    files = fs.readdirSync(SERVERS_REGISTRY_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const live: ServerConfig[] = [];
  for (const file of files) {
    const filePath = path.join(SERVERS_REGISTRY_DIR, file);
    try {
      const entry = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      if (!isServerConfig(entry)) {
        hookDebug(`registry-skip reason=malformed file=${file} err=invalid-server-config`);
        continue;
      }
      if (isProcessAlive(entry.pid)) {
        live.push(entry);
      } else {
        dead.push(entry);
        hookDebug(`registry-skip reason=dead-pid file=${file} pid=${entry.pid}`);
      }
    } catch (e) {
      hookDebug(
        `registry-skip reason=malformed file=${file} err=${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return live;
}

/**
 * POST one hook event to one server. Best-effort: every failure path (bad
 * connection, timeout, non-2xx status) resolves quietly -- a dropped delivery
 * to one server must never affect delivery to any other server, nor the
 * script's exit code.
 */
function postToServer(
  server: ServerTarget,
  body: string,
  eventName: string,
  sid: string,
): Promise<void> {
  hookDebug(`POST event=${eventName} sid=${sid} port=${server.port}`);
  return new Promise((resolve) => {
    try {
      const req = http.request(
        {
          hostname: server.host ?? '127.0.0.1',
          port: server.port,
          path: `${HOOK_API_PREFIX}/claude`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${server.token}`,
          },
          timeout: 2000,
        },
        (res) => {
          hookDebug(
            `POST-done event=${eventName} sid=${sid} status=${res.statusCode} port=${server.port}`,
          );
          res.resume();
          resolve();
        },
      );
      req.on('error', (err) => {
        hookDebug(
          `POST-error event=${eventName} sid=${sid} port=${server.port} err=${err.message}`,
        );
        resolve();
      });
      req.on('timeout', () => {
        hookDebug(`POST-timeout event=${eventName} sid=${sid} port=${server.port}`);
        req.destroy();
        resolve();
      });
      req.end(body);
    } catch (err) {
      hookDebug(
        `POST-error event=${eventName} sid=${sid} port=${server.port} err=${err instanceof Error ? err.message : String(err)}`,
      );
      resolve();
    }
  });
}

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    hookDebug('exit reason=bad-stdin');
    process.exit(0);
  }

  const eventName = (data.hook_event_name as string | undefined) ?? '?';
  const sid = (data.session_id as string | undefined)?.slice(0, 8) ?? '?';

  // Multi-server fan-out (D4): deliver to every live server in the registry.
  // Falls back to the single legacy server.json when the registry has no live
  // entries -- e.g. a server on disk that predates the registry (A1/A2).
  const dead: ServerTarget[] = [];
  let servers: ServerTarget[] = readRegistry(dead);
  if (servers.length === 0) {
    try {
      const legacy = JSON.parse(fs.readFileSync(SERVER_JSON, 'utf-8')) as unknown;
      if (!isServerTarget(legacy)) {
        throw new Error('invalid legacy server config');
      }
      if (
        dead.some((entry) => sameServerGeneration(entry, legacy)) ||
        !isProcessAlive(legacy.pid)
      ) {
        hookDebug(`exit reason=legacy-dead-pid event=${eventName} sid=${sid}`);
        return;
      }
      if ((await probeServer(legacy, HOOK_LEGACY_PROBE_TIMEOUT_MS)) === 'stale') {
        hookDebug(`exit reason=legacy-not-healthy event=${eventName} sid=${sid}`);
        return;
      }
      servers = [legacy];
    } catch (e) {
      hookDebug(
        `exit reason=no-server-json event=${eventName} sid=${sid} path=${SERVER_JSON} err=${e instanceof Error ? e.message : String(e)}`,
      );
      process.exit(0);
    }
  }

  // Adopt the first live server's debug-log path if the env var didn't reach
  // us (diagnostic-only; harmless if more than one server has it set).
  if (!debugLogPath) {
    const withDebugLog = servers.find((s) => s.debugLog);
    if (withDebugLog?.debugLog) debugLogPath = withDebugLog.debugLog;
  }

  const body = hookBody(data);
  await Promise.all(servers.map((server) => postToServer(server, body, eventName, sid)));
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
