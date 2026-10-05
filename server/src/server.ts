import * as crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import * as fs from 'fs';

import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type {
  AssetCache,
  ReloadAssetsSideEffect,
  SetHooksEnabledSideEffect,
} from './clientMessageHandler.js';
import { SERVER_JSON_NAME, SERVER_REGISTRY_PROTOCOL_VERSION, SERVERS_DIR } from './constants.js';
import {
  discoveryPath,
  isProcessRunning,
  sameServerGeneration,
  withDiscoveryLock,
  writeDiscoveryRecord,
} from './discoveryRecords.js';
import { probeServer } from './serverProbe.js';
export type { ServerProbe } from './serverProbe.js';
export { probeServer } from './serverProbe.js';
import { createHttpServer } from './httpServer.js';
import type { ServerConfig, ServerTarget } from './serverConfig.js';
import { isServerConfig, isServerTarget } from './serverConfig.js';

export type { ServerConfig } from './serverConfig.js';

/** Callback invoked when a hook event is received from a provider's hook script. */
type HookEventCallback = (providerId: string, event: Record<string, unknown>) => void;

/**
 * Pixel Agents server: receives hook events, broadcasts state via WebSocket,
 * and optionally serves the SPA in standalone mode.
 *
 * Routes (via Fastify in httpServer.ts):
 * - `POST /api/hooks/:providerId` -- hook event (auth required, 64KB body limit)
 * - `GET /api/health` -- health check (no auth)
 * - `GET /ws` -- WebSocket for real-time agent state (auth required)
 *
 * Discovery: writes `~/.pixel-agents/server.json` (legacy single-target pointer)
 * and `~/.pixel-agents/servers/<pid>-<port>.json` (multi-server registry entry)
 * with port, PID, auth token, and capability flags.
 * Multi-window / multi-surface: a second instance detects running servers via
 * the registry and reuses one only when it offers the same capability
 * (embedded reuses embedded, standalone reuses standalone) -- an embedded
 * VS Code server and a standalone `npx pixel-agents` server can run at once,
 * each owning its own registry entry, both reachable by hook fan-out.
 */
export class PixelAgentsServer {
  private app: FastifyInstance | null = null;
  private config: ServerConfig | null = null;
  private ownsServer = false;
  private callback: HookEventCallback | null = null;

  /** Register a callback for incoming hook events from any provider. */
  onHookEvent(callback: HookEventCallback): void {
    this.callback = callback;
  }

  /**
   * Start the server. If a compatible instance is already running (detected via
   * the multi-server registry), reuses its config without starting a new one.
   */
  async start(options?: {
    store?: AgentStateStore;
    runtime?: AgentRuntime;
    embedded?: boolean;
    host?: string;
    port?: number;
    staticDir?: string;
    assetCache?: AssetCache;
    onSetHooksEnabled?: SetHooksEnabledSideEffect;
    onReloadAssets?: ReloadAssetsSideEffect;
  }): Promise<ServerConfig> {
    const embedded = options?.embedded ?? true;
    const wantsSpa = !embedded;

    // Capability-based reuse: an embedded (VS Code) caller only reuses another
    // embedded server (today's multi-window sharing); a standalone caller only
    // reuses another standalone -- never across the boundary, which is what
    // used to leave a standalone attached to VS Code's SPA-less embedded
    // server (blank page). Prune dead entries first so a crashed server's
    // stale file never blocks discovery of a live one; a live PID alone is not
    // a live server (SA-076), so only an entry that answers /api/health is reused.
    const candidate = await this.findReusableServer(wantsSpa);
    if (candidate) {
      this.config = candidate;
      this.ownsServer = false;
      console.log(
        `[Pixel Agents] Reusing existing ${wantsSpa ? 'standalone' : 'embedded'} server on port ${candidate.port} (PID ${candidate.pid})`,
      );
      return candidate;
    }

    // Start our own server
    const token = crypto.randomUUID();
    const store = options?.store;

    const { app, port, host } = await createHttpServer({
      embedded,
      host: options?.host,
      port: options?.port,
      token,
      store: store!,
      runtime: options?.runtime,
      staticDir: options?.staticDir,
      assetCache: options?.assetCache,
      onHookEvent: (providerId, event) => this.callback?.(providerId, event),
      onSetHooksEnabled: options?.onSetHooksEnabled,
      onReloadAssets: options?.onReloadAssets,
    });

    this.app = app;
    this.config = {
      port,
      ...(host !== '127.0.0.1' ? { host } : {}),
      pid: process.pid,
      token,
      startedAt: Date.now(),
      servesSpa: wantsSpa,
      protocol: SERVER_REGISTRY_PROTOCOL_VERSION,
      // Diagnostic-only: forward the debug-log path to the hook script via
      // server.json (env vars don't reach the spawned hook reliably).
      ...(process.env['PIXEL_AGENTS_DEBUG_LOG']
        ? { debugLog: process.env['PIXEL_AGENTS_DEBUG_LOG'] }
        : {}),
    };
    this.ownsServer = true;
    // Dual-write: legacy single-target pointer (old hook scripts) + registry
    // entry (new hook scripts fan out to every entry here).
    try {
      withDiscoveryLock(() => {
        this.writeServerJson(this.config!);
        this.writeRegistryEntry(this.config!);
      });
    } catch (error) {
      console.error(`[Pixel Agents] Failed to publish discovery records: ${error}`);
    }
    console.log(`[Pixel Agents] Server: listening on ${host}:${port}`);

    return this.config;
  }

  /** Stop the server and clean up its discovery records (only if we own them). */
  stop(): void {
    if (this.app) {
      this.app.close();
      this.app = null;
    }
    if (this.ownsServer) {
      try {
        withDiscoveryLock(() => {
          this.deleteServerJson();
          this.deleteRegistryEntry();
        });
      } catch (error) {
        console.error(`[Pixel Agents] Failed to clean discovery records: ${error}`);
      }
    }
    this.config = null;
    this.ownsServer = false;
  }

  /** Returns the current server config, or null if not started. */
  getConfig(): ServerConfig | null {
    return this.config;
  }

  /** Returns the absolute path to ~/.pixel-agents/server.json. */
  private getServerJsonPath(): string {
    return discoveryPath(SERVER_JSON_NAME);
  }

  /** Called under the discovery lock, after listen has completed. */
  private writeServerJson(config: ServerConfig): void {
    writeDiscoveryRecord(SERVER_JSON_NAME, config);
  }

  /** Cleanup only our exact generation; old scripts still see a single pointer. */
  private deleteServerJson(): void {
    if (this.config) this.deleteLegacyPointer(this.config);
  }

  /** Returns the absolute path to ~/.pixel-agents/servers/. */
  private getRegistryDir(): string {
    return discoveryPath(SERVERS_DIR);
  }

  /**
   * Read every registry entry, pruning (deleting) any whose owning PID is no
   * longer alive -- so a crashed server's stale file never blocks discovery
   * or gets fanned out to by the hook script. Malformed/mid-write files are
   * treated the same as dead entries and removed. Returns only live entries.
   */
  private readAndPruneRegistry(): Array<{ config: ServerConfig; file: string }> {
    try {
      return withDiscoveryLock(() => {
        const dir = this.getRegistryDir();
        const live: Array<{ config: ServerConfig; file: string }> = [];
        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
          const relative = `${SERVERS_DIR}/${file}`;
          // Read and prune under the publication lock. Escaping or broken links
          // fail closed, including when the final record itself is a symlink.
          try {
            const entry = JSON.parse(fs.readFileSync(discoveryPath(relative), 'utf8')) as unknown;
            if (isServerConfig(entry) && isProcessRunning(entry.pid)) {
              live.push({ config: entry, file: relative });
            } else {
              fs.unlinkSync(discoveryPath(relative));
            }
          } catch {
            try {
              fs.unlinkSync(discoveryPath(relative));
            } catch {
              /* fail closed */
            }
          }
        }
        return live;
      });
    } catch {
      return [];
    }
  }

  /**
   * Probe every PID-live registry entry, plus the legacy server.json pointer,
   * and return the first healthy entry offering the wanted capability. An
   * entry that is refused or answered by another PID is stale -- typically a
   * crashed server whose PID Windows handed to an unrelated process -- and is
   * pruned like a dead PID, together with a server.json pointing at it. A
   * timeout is a busy server: it is neither reused nor pruned.
   */
  private async findReusableServer(wantsSpa: boolean): Promise<ServerConfig | undefined> {
    const registry = this.readAndPruneRegistry();
    const probes = await Promise.all(registry.map(({ config }) => probeServer(config)));
    const ignore = (target: ServerTarget) =>
      console.log(
        `[Pixel Agents] Ignoring stale server registration on port ${target.port} (PID ${target.pid}): it does not answer as that server`,
      );
    for (const [i, { config, file }] of registry.entries()) {
      if (probes[i] !== 'stale') continue;
      ignore(config);
      try {
        withDiscoveryLock(() => this.deleteMatchingRecord(file, config));
      } catch {
        /* already gone */
      }
    }
    let legacy: ServerTarget | undefined;
    try {
      const pointer = JSON.parse(fs.readFileSync(this.getServerJsonPath(), 'utf-8')) as unknown;
      if (isServerTarget(pointer)) legacy = pointer;
    } catch {
      // No legacy pointer, or unreadable: nothing to verify.
    }
    if (legacy) {
      // A pointer naming a registered server shares that entry's verdict.
      const index = registry.findIndex(({ config }) => sameServerGeneration(config, legacy!));
      const verdict = index >= 0 ? probes[index] : await probeServer(legacy);
      if (verdict === 'stale') {
        if (index < 0) ignore(legacy);
        try {
          withDiscoveryLock(() => this.deleteLegacyPointer(legacy!));
        } catch {
          /* fail closed */
        }
      }
    }
    return registry.find(
      ({ config }, i) => probes[i] === 'healthy' && config.servesSpa === wantsSpa,
    )?.config;
  }

  /** Delete server.json only while it still holds exactly this stale target. */
  private deleteLegacyPointer(target: ServerTarget): void {
    this.deleteMatchingRecord(SERVER_JSON_NAME, target);
  }

  /** Under the publication lock: re-read and delete only this generation. */
  private deleteMatchingRecord(relative: string, target: ServerTarget): void {
    try {
      const current = JSON.parse(fs.readFileSync(discoveryPath(relative), 'utf8')) as unknown;
      if (isServerTarget(current) && sameServerGeneration(current, target)) {
        fs.unlinkSync(discoveryPath(relative));
      }
    } catch {
      // Already gone, physically outside the root, or unreadable: leave alone.
    }
  }

  /** Called under the discovery lock. */
  private writeRegistryEntry(config: ServerConfig): void {
    writeDiscoveryRecord(`${SERVERS_DIR}/${config.pid}-${config.port}.json`, config);
  }

  /** Stop cleanup uses the same generation check as stale probe cleanup. */
  private deleteRegistryEntry(): void {
    if (this.config) {
      this.deleteMatchingRecord(
        `${SERVERS_DIR}/${this.config.pid}-${this.config.port}.json`,
        this.config,
      );
    }
  }
}
