import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Use isolated temp HOME to avoid touching real ~/.pixel-agents/
let tmpBase: string;
let serverJsonDir: string;
let serverJsonPath: string;
let registryDir: string;

/** List registry entry files (excludes .tmp write-in-progress artifacts). */
function registryFiles(): string[] {
  try {
    return fs.readdirSync(registryDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

// Must import AFTER mock setup
const { PixelAgentsServer, probeServer } = await import('../src/server.js');
const probes = await import('../src/serverProbe.js');
const { withDiscoveryLock, writeDiscoveryRecord } = await import('../src/discoveryRecords.js');
const { isServerTarget } = await import('../src/serverConfig.js');
const { SERVER_HEALTH_MAX_BODY_CHARS, SERVER_HEALTH_PROBE_TIMEOUT_MS } =
  await import('../src/constants.js');

async function postHook(
  port: number,
  token: string,
  body: string,
  providerId = 'claude',
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/hooks/${providerId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body,
  });
}

describe('PixelAgentsServer', () => {
  let server: InstanceType<typeof PixelAgentsServer>;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-server-test-'));
    serverJsonDir = path.join(tmpBase, '.pixel-agents');
    serverJsonPath = path.join(serverJsonDir, 'server.json');
    registryDir = path.join(serverJsonDir, 'servers');
    fs.mkdirSync(serverJsonDir, { recursive: true });
    server = new PixelAgentsServer();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    server?.stop();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // 1. Server starts and returns config
  it('starts and returns config with port, token, pid', async () => {
    const config = await server.start();
    expect(config.port).toBeGreaterThan(0);
    expect(config.token).toBeTruthy();
    expect(config.pid).toBe(process.pid);
    expect(config.startedAt).toBeGreaterThan(0);
  });

  // 2. Health endpoint returns 200 + uptime
  it('health endpoint returns 200 with uptime', async () => {
    const config = await server.start();
    const res = await fetch(`http://127.0.0.1:${config.port}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; uptime: number; pid: number };
    expect(body.status).toBe('ok');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.pid).toBe(process.pid);
  });

  // 3. Hook endpoint requires auth
  it('hook endpoint returns 401 without auth', async () => {
    const config = await server.start();
    const res = await fetch(`http://127.0.0.1:${config.port}/api/hooks/claude`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  // 4. Hook endpoint accepts valid auth
  it('hook endpoint returns 200 with valid auth', async () => {
    const config = await server.start();
    const res = await postHook(
      config.port,
      config.token,
      JSON.stringify({ session_id: 'test', hook_event_name: 'Stop' }),
    );
    expect(res.status).toBe(200);
  });

  // 5. Hook callback fires on valid event
  it('hook callback fires on valid event', async () => {
    const config = await server.start();
    const received: Array<{ providerId: string; event: Record<string, unknown> }> = [];
    server.onHookEvent((providerId: string, event: Record<string, unknown>) => {
      received.push({ providerId, event });
    });

    await postHook(
      config.port,
      config.token,
      JSON.stringify({ session_id: 'abc', hook_event_name: 'Stop' }),
    );

    expect(received).toHaveLength(1);
    expect(received[0].providerId).toBe('claude');
    expect(received[0].event.session_id).toBe('abc');
    expect(received[0].event.hook_event_name).toBe('Stop');
  });

  // 6. Hook endpoint rejects oversized body
  it('hook endpoint returns 413 for oversized body', async () => {
    const config = await server.start();
    const bigBody = 'x'.repeat(70_000); // > 64KB
    const res = await postHook(config.port, config.token, bigBody);
    expect(res.status).toBe(413);
  });

  // 7. Hook endpoint rejects invalid JSON
  it('hook endpoint returns 400 for invalid JSON', async () => {
    const config = await server.start();
    const res = await postHook(config.port, config.token, 'not json {{{');
    expect(res.status).toBe(400);
  });

  // 8. Hook endpoint rejects missing provider ID
  it('hook endpoint returns 400 for missing provider ID', async () => {
    const config = await server.start();
    const res = await fetch(`http://127.0.0.1:${config.port}/api/hooks/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  // 9. server.json written
  it('writes server.json with port, pid, token', async () => {
    const config = await server.start();
    const json = JSON.parse(fs.readFileSync(serverJsonPath, 'utf-8'));
    expect(json.port).toBe(config.port);
    expect(json.pid).toBe(process.pid);
    expect(json.token).toBe(config.token);
  });

  // 10. Registry entry written alongside the legacy server.json
  it('writes a registry entry with port, pid, servesSpa, protocol', async () => {
    const config = await server.start();
    const files = registryFiles();
    expect(files).toHaveLength(1);
    const entry = JSON.parse(fs.readFileSync(path.join(registryDir, files[0]), 'utf-8'));
    expect(entry.port).toBe(config.port);
    expect(entry.pid).toBe(process.pid);
    expect(entry.token).toBe(config.token);
    expect(entry.servesSpa).toBe(false); // embedded (default) never serves the SPA
    expect(typeof entry.protocol).toBe('number');
  });

  // 11. Second instance, same capability (embedded+embedded), reuses existing server
  it('second embedded instance reuses an existing embedded server', async () => {
    const config1 = await server.start({ embedded: true });
    const server2 = new PixelAgentsServer();
    const config2 = await server2.start({ embedded: true });
    expect(config2.port).toBe(config1.port);
    expect(config2.pid).toBe(config1.pid);
    expect(registryFiles()).toHaveLength(1); // reuse -- server2 wrote no entry of its own
    server2.stop(); // should not delete server.json / the registry entry (not owner)
  });

  // 12. Second instance, same capability (standalone+standalone), reuses existing server
  it('second standalone instance reuses an existing standalone server', async () => {
    const config1 = await server.start({ embedded: false });
    const server2 = new PixelAgentsServer();
    const config2 = await server2.start({ embedded: false });
    expect(config2.port).toBe(config1.port);
    expect(registryFiles()).toHaveLength(1);
    server2.stop();
  });

  // 13. Capability mismatch: a standalone caller never reuses an embedded server
  it('standalone does not reuse an existing embedded server; starts its own', async () => {
    const config1 = await server.start({ embedded: true });
    const server2 = new PixelAgentsServer();
    const config2 = await server2.start({ embedded: false });
    expect(config2.port).not.toBe(config1.port);
    expect(registryFiles()).toHaveLength(2);
    server2.stop();
  });

  // 14. Capability mismatch, mirrored: an embedded caller never reuses a standalone server
  it('embedded does not reuse an existing standalone server; starts its own', async () => {
    const config1 = await server.start({ embedded: false });
    const server2 = new PixelAgentsServer();
    const config2 = await server2.start({ embedded: true });
    expect(config2.port).not.toBe(config1.port);
    expect(registryFiles()).toHaveLength(2);
    server2.stop();
  });

  // 15. Embedded + standalone coexist: two independent live registry entries, neither reuses
  it('embedded and standalone servers coexist as two live registry entries', async () => {
    const embeddedConfig = await server.start({ embedded: true });
    const standalone = new PixelAgentsServer();
    const standaloneConfig = await standalone.start({ embedded: false });

    expect(standaloneConfig.port).not.toBe(embeddedConfig.port);
    expect(standaloneConfig.token).not.toBe(embeddedConfig.token);
    const files = registryFiles();
    expect(files).toHaveLength(2);
    const entries = files.map((f) =>
      JSON.parse(fs.readFileSync(path.join(registryDir, f), 'utf-8')),
    );
    expect(entries.some((e) => e.servesSpa === false && e.port === embeddedConfig.port)).toBe(true);
    expect(entries.some((e) => e.servesSpa === true && e.port === standaloneConfig.port)).toBe(
      true,
    );

    standalone.stop();
  });

  // 16. Dead-pid registry entries are pruned on start, never reused
  it('prunes dead-pid registry entries on start instead of reusing them', async () => {
    fs.mkdirSync(registryDir, { recursive: true });
    const staleFile = path.join(registryDir, '999999-9999.json');
    fs.writeFileSync(
      staleFile,
      JSON.stringify({
        port: 9999,
        pid: 999999,
        token: 'stale',
        startedAt: 0,
        servesSpa: false,
        protocol: 1,
      }),
    );

    const config = await server.start({ embedded: true });

    expect(fs.existsSync(staleFile)).toBe(false); // pruned, not left behind
    expect(config.port).not.toBe(9999); // never reused the dead entry -- started its own
    expect(registryFiles()).toHaveLength(1); // only the freshly-started server's entry remains
  });

  // 17. Structurally invalid live-pid entries are malformed, not reusable
  it('prunes a structurally invalid live-pid entry instead of reusing it', async () => {
    fs.mkdirSync(registryDir, { recursive: true });
    const malformedFile = path.join(registryDir, `${process.pid}-70000.json`);
    fs.writeFileSync(
      malformedFile,
      JSON.stringify({
        port: 70_000,
        pid: process.pid,
        token: 'invalid-port',
        startedAt: Date.now(),
        servesSpa: false,
        protocol: 1,
      }),
    );

    const config = await server.start({ embedded: true });

    expect(config.port).not.toBe(70_000);
    expect(fs.existsSync(malformedFile)).toBe(false);
    expect(registryFiles()).toHaveLength(1);
  });

  // SA-076: Windows recycles PIDs, so a crashed server's entry can name a live
  // but unrelated process. Only an entry that answers /api/health is reused.
  describe('stale registrations with a live PID (SA-076)', () => {
    const listeners: http.Server[] = [];
    afterEach(async () => {
      for (const listener of listeners.splice(0)) {
        listener.closeAllConnections();
        await new Promise((resolve) => listener.close(resolve));
      }
    });
    async function listen(handler?: http.RequestListener): Promise<number> {
      const listener = http.createServer(handler);
      await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
      listeners.push(listener);
      return (listener.address() as AddressInfo).port;
    }
    async function closedPort(): Promise<number> {
      const port = await listen();
      const listener = listeners.pop()!;
      await new Promise((resolve) => listener.close(resolve));
      return port;
    }
    function register(port: number, extra: object = {}): string {
      fs.mkdirSync(registryDir, { recursive: true });
      const file = path.join(registryDir, `${process.pid}-${port}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify({
          port,
          pid: process.pid, // alive: this very test process
          token: 'stale',
          startedAt: 0,
          servesSpa: false,
          protocol: 1,
          ...extra,
        }),
      );
      return file;
    }

    it('does not reuse a live-pid entry with nothing listening; prunes it and server.json', async () => {
      const port = await closedPort();
      const file = register(port);
      fs.writeFileSync(serverJsonPath, fs.readFileSync(file));

      const config = await server.start({ embedded: true });

      expect(config.port).not.toBe(port);
      expect(config.token).not.toBe('stale');
      expect(fs.existsSync(file)).toBe(false);
      expect(registryFiles()).toEqual([`${process.pid}-${config.port}.json`]);
      expect(JSON.parse(fs.readFileSync(serverJsonPath, 'utf-8')).port).toBe(config.port);
    });

    it('does not reuse a port answered by another process', async () => {
      const port = await listen((_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', pid: process.pid + 1 }));
      });
      const file = register(port);

      const config = await server.start({ embedded: true });

      expect(config.port).not.toBe(port);
      expect(fs.existsSync(file)).toBe(false);
    });

    it('neither reuses nor prunes a server too busy to answer', async () => {
      const port = await listen(() => {
        /* never answers */
      });
      const file = register(port);

      const config = await server.start({ embedded: true });

      expect(config.port).not.toBe(port);
      expect(fs.existsSync(file)).toBe(true);
    });

    it('reuses a healthy server and drops a stale legacy pointer', async () => {
      const first = await server.start({ embedded: true });
      const port = await closedPort();
      fs.writeFileSync(
        serverJsonPath,
        JSON.stringify({ port, pid: process.pid, token: 'stale-pointer' }),
      );
      const second = new PixelAgentsServer();

      const reused = await second.start({ embedded: true });

      expect(reused.port).toBe(first.port);
      expect(reused.token).toBe(first.token);
      expect(fs.existsSync(serverJsonPath)).toBe(false);
      expect(registryFiles()).toHaveLength(1);
      second.stop();
    });

    it('bounds continuous streaming and still reuses another healthy candidate', async () => {
      const healthy = await server.start();
      const streaming = await listen((_req, res) => {
        res.writeHead(200);
        res.write(' ');
        const interval = setInterval(() => res.write(' '), 20);
        res.on('close', () => clearInterval(interval));
      });
      const file = register(streaming);
      const beganProbe = Date.now();
      expect(await probeServer({ port: streaming, pid: process.pid }, 100)).toBe('unknown');
      expect(Date.now() - beganProbe).toBeLessThan(700);
      const second = new PixelAgentsServer();
      const beganReuse = Date.now();
      const reused = await second.start();
      expect(reused.token).toBe(healthy.token);
      expect(Date.now() - beganReuse).toBeLessThan(SERVER_HEALTH_PROBE_TIMEOUT_MS + 1000);
      expect(fs.existsSync(file)).toBe(true);
      second.stop();
    });

    it.each(['one chunk', 'several chunks'])(
      'rejects an oversized health body in %s',
      async (kind) => {
        const json = JSON.stringify({ pid: process.pid });
        const prefix = json + ' '.repeat(SERVER_HEALTH_MAX_BODY_CHARS - json.length);
        const port = await listen((_req, res) => {
          if (kind === 'one chunk') res.end(prefix + ' '.repeat(2000));
          else {
            res.write(prefix);
            setTimeout(() => res.end('THIS IS NOT JSON'), 20);
          }
        });
        expect(await probeServer({ port, pid: process.pid })).toBe('stale');
      },
    );

    it('preserves a new generation published after the old probe verdict', async () => {
      const healthy = await server.start();
      let requests = 0;
      const replacedPort = await listen((_req, res) =>
        res.end(JSON.stringify({ pid: ++requests === 1 ? process.pid + 1 : process.pid })),
      );
      const file = register(replacedPort);
      const old = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(serverJsonPath, JSON.stringify(old));
      const replacement = { ...old, token: 'new-generation', startedAt: 12345 };
      let oldVerdict!: () => void;
      const oldFinished = new Promise<void>((resolve) => {
        oldVerdict = resolve;
      });
      const original = probes.probeServer;
      vi.spyOn(probes, 'probeServer').mockImplementation(async (target, timeout) => {
        const verdict = await original(target, timeout);
        if (target.port === replacedPort && requests === 1) oldVerdict();
        if (target.port === healthy.port) {
          await oldFinished;
          withDiscoveryLock(() => {
            writeDiscoveryRecord('servers/' + path.basename(file), replacement);
            writeDiscoveryRecord('server.json', replacement);
          });
        }
        return verdict;
      });
      const second = new PixelAgentsServer();
      const reused = await second.start();
      expect(reused.token).toBe(healthy.token);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(replacement);
      expect(JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'))).toEqual(replacement);
      expect(requests).toBe(2); // The new legacy generation got its own verdict.
      second.stop();
    });

    it.each(['127.0.0.2', '::1'])('discovers and reuses the specific bind %s', async (host) => {
      const first = await server.start({ host });
      expect(first.host).toBe(host);
      expect(await probeServer(first)).toBe('healthy');
      const second = new PixelAgentsServer();
      expect((await second.start()).token).toBe(first.token);
      expect(registryFiles()).toHaveLength(1);
      second.stop();
    });

    it('accepts local interface IPs but rejects remote IPs, wildcards and DNS names', () => {
      for (const host of ['127.0.0.2', '::1']) {
        expect(isServerTarget({ port: 1234, pid: process.pid, token: 'x', host })).toBe(true);
      }
      for (const host of ['example.com', 'localhost', '192.0.2.1', '0.0.0.0', '::']) {
        expect(isServerTarget({ port: 1234, pid: process.pid, token: 'x', host })).toBe(false);
      }
      for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries ?? []) {
          expect(
            isServerTarget({ port: 1234, pid: process.pid, token: 'x', host: entry.address }),
          ).toBe(true);
        }
      }
    });

    it('probeServer tells healthy, stale and unknown apart', async () => {
      const healthy = await listen((_req, res) => res.end(JSON.stringify({ pid: 4242 })));
      const html = await listen((_req, res) => res.end('<html>not ours</html>'));
      const hanging = await listen(() => {
        /* never answers */
      });
      expect(await probeServer({ port: healthy, pid: 4242 })).toBe('healthy');
      expect(await probeServer({ port: healthy, pid: 4243 })).toBe('stale');
      expect(await probeServer({ port: html, pid: 4242 })).toBe('stale');
      expect(await probeServer({ port: await closedPort(), pid: 4242 })).toBe('stale');
      expect(await probeServer({ port: hanging, pid: 4242 }, 200)).toBe('unknown');
    });
  });

  it('stop preserves another generation on the same PID and port', async () => {
    const config = await server.start();
    const replacement = { ...config, token: 'replacement', startedAt: config.startedAt + 1 };
    withDiscoveryLock(() => {
      writeDiscoveryRecord('server.json', replacement);
      writeDiscoveryRecord('servers/' + process.pid + '-' + config.port + '.json', replacement);
    });
    server.stop();
    expect(JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'))).toEqual(replacement);
    expect(registryFiles()).toHaveLength(1);
  });

  it('recovers a dead lock owner and bounds contention with a live owner', () => {
    fs.mkdirSync(registryDir, { recursive: true });
    const lock = path.join(registryDir, '.discovery.lock');
    fs.writeFileSync(
      lock,
      JSON.stringify({ pid: 999999, nonce: '12345678-1234-1234-1234-123456789abc' }),
    );
    let called = false;
    withDiscoveryLock(() => {
      called = true;
    });
    expect(called).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    const live = JSON.stringify({
      pid: process.pid,
      nonce: '12345678-1234-1234-1234-123456789def',
    });
    fs.writeFileSync(lock, live);
    const began = Date.now();
    expect(() =>
      withDiscoveryLock(() => {
        throw new Error('must not run');
      }),
    ).toThrow('Discovery lock timed out');
    expect(Date.now() - began).toBeLessThan(1000);
    expect(fs.readFileSync(lock, 'utf8')).toBe(live);
  });

  it('cleans a unique temporary when publication fails and preserves a shared legacy tmp', () => {
    const oldTmp = serverJsonPath + '.tmp';
    fs.writeFileSync(oldTmp, 'other writer');
    fs.mkdirSync(serverJsonPath); // A directory is an actual failed rename destination.
    withDiscoveryLock(() => {
      expect(() =>
        writeDiscoveryRecord('server.json', { pid: process.pid, port: 1234, token: 'x' }),
      ).toThrow();
    });
    expect(fs.readFileSync(oldTmp, 'utf8')).toBe('other writer');
    expect(fs.readdirSync(serverJsonDir).filter((file) => file.endsWith('.tmp'))).toEqual([
      'server.json.tmp',
    ]);
  });

  it('refuses registry writes and pruning through an escaping directory link', async () => {
    const outside = path.join(tmpBase, 'outside');
    fs.mkdirSync(outside);
    const external = path.join(outside, 'dead.json');
    fs.writeFileSync(external, 'external data');
    fs.symlinkSync(outside, registryDir, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await server.start();
      server.stop();
      expect(fs.readFileSync(external, 'utf8')).toBe('external data');
      expect(fs.readdirSync(outside)).toEqual(['dead.json']);
      expect(fs.existsSync(serverJsonPath)).toBe(false);
    } finally {
      fs.unlinkSync(registryDir);
    }
  });

  it('refuses publication and cleanup through an escaping server.json link', async () => {
    const outside = path.join(tmpBase, 'pointer-target');
    fs.mkdirSync(outside);
    const external = path.join(outside, 'data.json');
    fs.writeFileSync(external, 'external data');
    // A junction needs no file-symlink privilege on Windows and exercises the
    // final server.json path's realpath containment, even for a malformed pointer.
    fs.symlinkSync(outside, serverJsonPath, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await server.start();
      server.stop();
      expect(fs.readFileSync(external, 'utf8')).toBe('external data');
      expect(fs.readdirSync(outside)).toEqual(['data.json']);
      expect(fs.lstatSync(serverJsonPath).isSymbolicLink()).toBe(true);
    } finally {
      fs.unlinkSync(serverJsonPath);
    }
  });

  it('waits for an independent process to finish its locked publication', async () => {
    fs.mkdirSync(registryDir, { recursive: true });
    const code = [
      "const fs = require('fs'); const path = require('path');",
      "const dir = process.argv[1]; const lock = path.join(dir, '.discovery.lock');",
      "fs.writeFileSync(lock, JSON.stringify({pid: process.pid, nonce: '12345678-1234-1234-1234-123456789abc'}), {flag: 'wx'});",
      "process.stdout.write('locked');",
      "setTimeout(() => {fs.writeFileSync(path.join(dir, 'published.txt'), 'published'); fs.unlinkSync(lock);}, 100);",
    ].join(' ');
    const child = spawn(process.execPath, ['-e', code, registryDir], {
      env: { ...process.env, HOME: tmpBase, USERPROFILE: tmpBase },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve());
        child.once('error', reject);
        child.once('exit', (code) => {
          if (code !== 0) reject(new Error('Lock holder failed'));
        });
      });
      withDiscoveryLock(() => {
        expect(fs.readFileSync(path.join(registryDir, 'published.txt'), 'utf8')).toBe('published');
      });
    } finally {
      child.kill();
      if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    }
  });

  it('simultaneous starts publish distinct entries and complete legacy pointers', async () => {
    const second = new PixelAgentsServer();
    try {
      const configs = await Promise.all([server.start(), second.start()]);
      expect(new Set(configs.map((config) => config.port)).size).toBe(2);
      expect(registryFiles()).toHaveLength(2);
      const pointer = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));
      expect(configs).toContainEqual(pointer);
      expect(await probeServer(pointer)).toBe('healthy');
      expect(fs.readdirSync(serverJsonDir).some((file) => file.endsWith('.tmp'))).toBe(false);
      expect(fs.readdirSync(registryDir).some((file) => file.endsWith('.tmp'))).toBe(false);
    } finally {
      second.stop();
    }
  });

  // 18. server.json cleaned up on stop
  it('deletes server.json on stop', async () => {
    await server.start();
    expect(fs.existsSync(serverJsonPath)).toBe(true);
    server.stop();
    expect(fs.existsSync(serverJsonPath)).toBe(false);
  });

  // 19. server.json NOT deleted if PID mismatch
  it('does not delete server.json if PID mismatch', async () => {
    // Write fake server.json with different PID
    fs.writeFileSync(
      serverJsonPath,
      JSON.stringify({ port: 9999, pid: 999999, token: 'fake', startedAt: 0 }),
    );
    // Server never started (it would reuse), just stop
    const server2 = new PixelAgentsServer();
    server2.stop();
    expect(fs.existsSync(serverJsonPath)).toBe(true);
  });

  // 20. stop() removes only this server's own registry entry, preserves the other's (D6)
  it('deletes only its own registry entry on stop, preserving a coexisting server', async () => {
    const embeddedConfig = await server.start({ embedded: true });
    const standalone = new PixelAgentsServer();
    const standaloneConfig = await standalone.start({ embedded: false });
    expect(registryFiles()).toHaveLength(2);

    standalone.stop();

    // Only the standalone's own entry is gone; the still-running embedded
    // server's registry entry is untouched (self-only cleanup, D6).
    const remaining = registryFiles().map(
      (f) => JSON.parse(fs.readFileSync(path.join(registryDir, f), 'utf-8')) as { port: number },
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].port).toBe(embeddedConfig.port);
    expect(remaining.some((e) => e.port === standaloneConfig.port)).toBe(false);
  });

  // 21. Unknown route returns 404
  it('unknown route returns 404', async () => {
    const config = await server.start();
    const res = await fetch(`http://127.0.0.1:${config.port}/random/path`);
    expect(res.status).toBe(404);
  });

  // 22. Hook callback does NOT fire for events missing required fields
  it('hook callback does not fire for events without session_id', async () => {
    const config = await server.start();
    const received: unknown[] = [];
    server.onHookEvent((_pid: string, event: Record<string, unknown>) => received.push(event));

    await postHook(
      config.port,
      config.token,
      JSON.stringify({ hook_event_name: 'Stop' }), // missing session_id
    );

    expect(received).toHaveLength(0);
  });
});
