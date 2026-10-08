import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HOOK_LEGACY_PROBE_TIMEOUT_MS } from '../src/constants.js';
import { canBind } from './helpers/bindable.js';

const HOOK_SCRIPT = path.join(__dirname, '../../dist/hooks/claude-hook.js');

// Isolated temp HOME
let tmpBase: string;

function writeServerJson(port: number, token: string, host?: string): void {
  const dir = path.join(tmpBase, '.pixel-agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'server.json'),
    JSON.stringify({
      port,
      pid: process.pid,
      token,
      startedAt: Date.now(),
      ...(host ? { host } : {}),
    }),
  );
}

/** Write one multi-server registry entry (~/.pixel-agents/servers/<pid>-<port>.json). */
function writeRegistryEntry(pid: number, port: number, token: string, host?: string): void {
  const dir = path.join(tmpBase, '.pixel-agents', 'servers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${pid}-${port}.json`),
    JSON.stringify({
      port,
      pid,
      token,
      startedAt: Date.now(),
      servesSpa: false,
      protocol: 1,
      ...(host ? { host } : {}),
    }),
  );
}

/** Start a bare HTTP server that records every request body it receives. */
function startRecordingServer(
  host = '127.0.0.1',
  healthPid = process.pid,
): Promise<{
  port: number;
  received: string[];
  requests: Array<{ method?: string; authorization?: string }>;
  close: () => void;
}> {
  const received: string[] = [];
  const requests: Array<{ method?: string; authorization?: string }> = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, authorization: req.headers.authorization });
    if (req.method === 'GET' && req.url === '/api/health') {
      res.end(JSON.stringify({ pid: healthPid }));
      return;
    }
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push(body);
      res.writeHead(200);
      res.end('ok');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        received,
        requests,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

/** Run the hook script with given stdin, returns exit code. */
function runHookScript(
  stdin: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [HOOK_SCRIPT], {
      // Set both HOME (POSIX) and USERPROFILE (Windows) so the child's
      // os.homedir() resolves to the isolated temp dir on every platform.
      env: { ...process.env, HOME: tmpBase, USERPROFILE: tmpBase, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe('claude-hook.js integration', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hook-int-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /** These tests spawn the BUNDLED hook script, so they need `npm run compile`
   *  to have run. Reported as a loud skip rather than an early `return`, which
   *  Vitest shows as PASSED with no message — a false green that hid the fact
   *  that nothing had been exercised at all. */
  const notBuilt = !fs.existsSync(HOOK_SCRIPT);
  const itBuilt = it.skipIf(notBuilt);

  // 1. Script reads stdin and POSTs to server
  itBuilt('reads stdin and POSTs to server', async () => {
    const received: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/health') {
        res.end(JSON.stringify({ pid: process.pid }));
        return;
      }
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push(body);
        res.writeHead(200);
        res.end('ok');
      });
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    writeServerJson(port, 'test-token');

    const event = JSON.stringify({ session_id: 'abc', hook_event_name: 'Stop' });
    const { code } = await runHookScript(event);

    server.close();
    expect(code).toBe(0);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]).session_id).toBe('abc');
  });

  // 2. Script exits 0 on missing server.json
  itBuilt('exits 0 when server.json is missing', async () => {
    // Don't write server.json
    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'x', hook_event_name: 'Stop' }),
    );
    expect(code).toBe(0);
  });

  // 5. Script exits 0 on invalid stdin
  itBuilt('exits 0 on invalid stdin', async () => {
    writeServerJson(9999, 'tok');
    const { code } = await runHookScript('not json at all!!!');
    expect(code).toBe(0);
  });

  // Unknown legacy health still attempts a POST with its own timeout.
  itBuilt('bounds legacy probe plus POST when neither responds', async () => {
    // Start a server that never responds
    const server = http.createServer(() => {
      // intentionally never respond
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    writeServerJson((server.address() as { port: number }).port, 'tok');

    const start = Date.now();
    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'x', hook_event_name: 'Stop' }),
    );
    const elapsed = Date.now() - start;

    server.closeAllConnections();
    server.close();
    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(5000);
  });

  itBuilt('pins the 300 ms legacy probe budget and delivers after unknown health', async () => {
    expect(HOOK_LEGACY_PROBE_TIMEOUT_MS).toBe(300);
    const requests: Array<{ method?: string; at: number }> = [];
    const server = http.createServer((req, res) => {
      requests.push({ method: req.method, at: Date.now() });
      if (req.method === 'POST') {
        req.resume();
        res.end('ok');
      }
      // GET intentionally hangs; POST proves unknown is not treated as stale.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      writeServerJson((server.address() as { port: number }).port, 'busy');
      expect((await runHookScript('{"session_id":"busy","hook_event_name":"Stop"}')).code).toBe(0);
      expect(requests.map((request) => request.method)).toEqual(['GET', 'POST']);
      const elapsed = requests[1].at - requests[0].at;
      expect(elapsed).toBeGreaterThanOrEqual(HOOK_LEGACY_PROBE_TIMEOUT_MS - 50);
      expect(elapsed).toBeLessThan(HOOK_LEGACY_PROBE_TIMEOUT_MS + 700);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  itBuilt('bounds legacy POST timeout after healthy GET', async () => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET') res.end(JSON.stringify({ pid: process.pid }));
      else req.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const log = path.join(tmpBase, 'legacy-post-timeout.log');
    try {
      writeServerJson((server.address() as { port: number }).port, 'busy-post');
      const began = Date.now();
      expect(
        (await runHookScript('{"hook_event_name":"Stop"}', { PIXEL_AGENTS_DEBUG_LOG: log })).code,
      ).toBe(0);
      expect(Date.now() - began).toBeLessThan(3500);
      expect(fs.readFileSync(log, 'utf8')).toContain('POST-timeout');
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  for (const registered of [false, true]) {
    itBuilt(`rejects dead legacy PID before probe (registered=${registered})`, async () => {
      const squatter = await startRecordingServer('127.0.0.1', 999999);
      try {
        writeServerJson(squatter.port, 'dead-secret');
        const pointer = path.join(tmpBase, '.pixel-agents', 'server.json');
        const dead = { ...JSON.parse(fs.readFileSync(pointer, 'utf8')), pid: 999999 };
        fs.writeFileSync(pointer, JSON.stringify(dead));
        if (registered) {
          const dir = path.join(tmpBase, '.pixel-agents', 'servers');
          fs.mkdirSync(dir);
          fs.writeFileSync(
            path.join(dir, `999999-${squatter.port}.json`),
            JSON.stringify({ ...dead, servesSpa: false, protocol: 1 }),
          );
        }
        const log = path.join(tmpBase, 'dead.log');
        expect(
          (await runHookScript('{"hook_event_name":"Stop"}', { PIXEL_AGENTS_DEBUG_LOG: log })).code,
        ).toBe(0);
        expect(squatter.requests).toEqual([]);
        expect(fs.readFileSync(log, 'utf8')).toContain('legacy-dead-pid');
        expect(JSON.parse(fs.readFileSync(pointer, 'utf8'))).toEqual(dead);
      } finally {
        squatter.close();
      }
    });
  }

  itBuilt('keeps registry fan-out probe-free and skips temporarily nonlocal hosts', async () => {
    const target = await startRecordingServer('127.0.0.1', process.pid + 1);
    try {
      writeRegistryEntry(process.pid, target.port, 'pid-only');
      writeRegistryEntry(process.pid, 65000, 'missing-interface', '192.0.2.1');
      const missing = path.join(tmpBase, '.pixel-agents', 'servers', `${process.pid}-65000.json`);
      const before = fs.readFileSync(missing, 'utf8');
      expect((await runHookScript('{"hook_event_name":"Stop"}')).code).toBe(0);
      expect(target.requests).toEqual([{ method: 'POST', authorization: 'Bearer pid-only' }]);
      expect(fs.readFileSync(missing, 'utf8')).toBe(before);
    } finally {
      target.close();
    }
  });

  // 7. Multi-server fan-out: one event reaches every live registry entry
  itBuilt('fans out to every live server in the registry', async () => {
    const a = await startRecordingServer();
    const b = await startRecordingServer();
    // Same real PID for both (this test process) is fine -- the registry
    // filename is keyed on pid+port, so two entries never collide.
    writeRegistryEntry(process.pid, a.port, 'token-a');
    writeRegistryEntry(process.pid, b.port, 'token-b');

    const event = JSON.stringify({ session_id: 'fanout', hook_event_name: 'Stop' });
    const { code } = await runHookScript(event);

    a.close();
    b.close();
    expect(code).toBe(0);
    expect(a.received).toHaveLength(1);
    expect(b.received).toHaveLength(1);
    expect(JSON.parse(a.received[0]).session_id).toBe('fanout');
    expect(JSON.parse(b.received[0]).session_id).toBe('fanout');
  });

  // 8. Dead-pid registry entries are skipped, not delivered to, and don't block live ones
  itBuilt('skips a dead-pid registry entry and still delivers to the live one', async () => {
    const live = await startRecordingServer();
    writeRegistryEntry(process.pid, live.port, 'token-live');
    // A stale entry for a PID that is certainly not alive. Port 9999 is
    // deliberately NOT bound by anything, so if the liveness filter failed
    // to skip it, the resulting POST would fail (ECONNREFUSED) and be
    // swallowed the same way a genuinely-filtered entry would be -- a
    // response-based assertion alone can't tell the two apart. The debug
    // log (below) is what actually proves the filter ran.
    const debugLog = path.join(tmpBase, 'hook-debug.log');
    writeRegistryEntry(999999, 9999, 'token-dead');

    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'skip-dead', hook_event_name: 'Stop' }),
      { PIXEL_AGENTS_DEBUG_LOG: debugLog },
    );

    live.close();
    expect(code).toBe(0);
    expect(live.received).toHaveLength(1);
    // Proves the dead entry was actually filtered by isProcessAlive, not
    // just attempted-and-failed: exactly one POST is logged (to the live
    // server), and the dead entry is logged as a registry-skip, never a POST.
    const debugText = fs.readFileSync(debugLog, 'utf-8');
    expect(debugText).toMatch(/registry-skip reason=dead-pid file=999999-9999\.json pid=999999/);
    expect(debugText).toMatch(new RegExp(`POST event=Stop sid=skip-dea port=${live.port}`));
    expect(debugText).not.toMatch(/POST event=Stop sid=skip-dea port=9999\b/);
  });

  // An EPERM PID is alive, just not ours to signal (an elevated server with Claude Code in a
  // normal terminal). PID 4 is Windows' System process, which always answers EPERM.
  (process.platform === 'win32' ? itBuilt : it.skip)(
    'delivers to a registry entry whose PID it cannot signal (EPERM counts as alive)',
    async () => {
      const elevated = await startRecordingServer();
      writeRegistryEntry(4, elevated.port, 'elevated-token');
      const { code } = await runHookScript(
        JSON.stringify({ session_id: 'eperm-live', hook_event_name: 'Stop' }),
      );
      elevated.close();
      expect(code).toBe(0);
      expect(elevated.received).toHaveLength(1);
    },
  );

  // 9. A structurally malformed live-pid entry never poisons healthy fan-out
  itBuilt('skips an invalid live-pid entry and still delivers to the healthy server', async () => {
    const healthy = await startRecordingServer();
    writeRegistryEntry(process.pid, 70_000, 'invalid-port');
    writeRegistryEntry(process.pid, healthy.port, 'healthy-token');
    const debugLog = path.join(tmpBase, 'hook-debug.log');

    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'malformed-live', hook_event_name: 'Stop' }),
      { PIXEL_AGENTS_DEBUG_LOG: debugLog },
    );

    healthy.close();
    expect(code).toBe(0);
    expect(healthy.received).toHaveLength(1);
    const debugText = fs.readFileSync(debugLog, 'utf-8');
    expect(debugText).toMatch(
      new RegExp(`registry-skip reason=malformed file=${process.pid}-70000\\.json`),
    );
    expect(debugText).toMatch(new RegExp(`POST event=Stop sid=malforme port=${healthy.port}`));
    expect(debugText).not.toMatch(/POST event=Stop sid=malforme port=70000\b/);
  });

  // 10. Registry present but empty falls back to the legacy server.json
  itBuilt('falls back to legacy server.json when the registry directory is empty', async () => {
    fs.mkdirSync(path.join(tmpBase, '.pixel-agents', 'servers'), { recursive: true });
    const legacy = await startRecordingServer();
    writeServerJson(legacy.port, 'legacy-token');

    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'legacy-fallback', hook_event_name: 'Stop' }),
    );

    legacy.close();
    expect(code).toBe(0);
    expect(legacy.received).toHaveLength(1);
  });

  itBuilt(
    'probes legacy health without sending credentials, and leaves healthy files intact',
    async () => {
      const legacy = await startRecordingServer();
      try {
        writeServerJson(legacy.port, 'legacy-token');
        const registry = path.join(tmpBase, '.pixel-agents', 'servers');
        fs.mkdirSync(registry, { recursive: true });
        const malformed = path.join(registry, 'malformed.json');
        fs.writeFileSync(malformed, 'unparseable');
        const pointer = path.join(tmpBase, '.pixel-agents', 'server.json');
        const before = fs.readFileSync(pointer, 'utf8');
        expect(
          (await runHookScript(JSON.stringify({ session_id: 'healthy', hook_event_name: 'Stop' })))
            .code,
        ).toBe(0);
        expect(legacy.received).toHaveLength(1);
        expect(legacy.requests).toEqual([
          { method: 'GET', authorization: undefined },
          { method: 'POST', authorization: 'Bearer legacy-token' },
        ]);
        expect(fs.readFileSync(pointer, 'utf8')).toBe(before);
        expect(fs.readFileSync(malformed, 'utf8')).toBe('unparseable');
      } finally {
        legacy.close();
      }
    },
  );

  itBuilt(
    'does not POST to a stale legacy listener and preserves all discovery files',
    async () => {
      const stale = await startRecordingServer('127.0.0.1', process.pid + 1);
      try {
        writeServerJson(stale.port, 'secret-legacy-token');
        const pointer = path.join(tmpBase, '.pixel-agents', 'server.json');
        const before = fs.readFileSync(pointer, 'utf8');
        writeRegistryEntry(999999, stale.port, 'dead-token');
        const dead = path.join(
          tmpBase,
          '.pixel-agents',
          'servers',
          '999999-' + stale.port + '.json',
        );
        const deadBefore = fs.readFileSync(dead, 'utf8');
        expect(
          (await runHookScript(JSON.stringify({ session_id: 'stale', hook_event_name: 'Stop' })))
            .code,
        ).toBe(0);
        expect(stale.received).toHaveLength(0);
        expect(stale.requests).toEqual([{ method: 'GET', authorization: undefined }]);
        expect(fs.readFileSync(pointer, 'utf8')).toBe(before);
        expect(fs.readFileSync(dead, 'utf8')).toBe(deadBefore);
      } finally {
        stale.close();
      }
    },
  );

  itBuilt('does not attempt a POST for a live-pid legacy pointer with a closed port', async () => {
    const closed = await startRecordingServer();
    closed.close();
    writeServerJson(closed.port, 'stale-token');
    const pointer = path.join(tmpBase, '.pixel-agents', 'server.json');
    const before = fs.readFileSync(pointer, 'utf8');
    const log = path.join(tmpBase, 'debug.log');
    expect(
      (
        await runHookScript(JSON.stringify({ session_id: 'closed', hook_event_name: 'Stop' }), {
          PIXEL_AGENTS_DEBUG_LOG: log,
        })
      ).code,
    ).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).toContain('legacy-not-healthy');
    expect(fs.readFileSync(log, 'utf8')).not.toContain('POST event=');
    expect(fs.readFileSync(pointer, 'utf8')).toBe(before);
  });

  for (const host of ['127.0.0.2', '::1']) {
    for (const source of ['registry', 'legacy']) {
      itBuilt('delivers using ' + source + ' specific bind ' + host, async (context) => {
        if (!(await canBind(host))) context.skip(`Cannot bind ${host} on this runner`);
        const target = await startRecordingServer(host);
        try {
          if (source === 'registry')
            writeRegistryEntry(process.pid, target.port, 'host-token', host);
          else writeServerJson(target.port, 'host-token', host);
          expect(
            (await runHookScript(JSON.stringify({ session_id: 'bind', hook_event_name: 'Stop' })))
              .code,
          ).toBe(0);
          expect(target.received).toHaveLength(1);
          expect(target.requests.map((request) => request.method)).toEqual(
            source === 'registry' ? ['POST'] : ['GET', 'POST'],
          );
        } finally {
          target.close();
        }
      });
    }
  }

  itBuilt('skips a DNS destination in both the registry and legacy pointer', async () => {
    const target = await startRecordingServer();
    try {
      writeServerJson(target.port, 'host-token', 'localhost');
      writeRegistryEntry(process.pid, target.port, 'host-token', 'localhost');
      expect(
        (await runHookScript(JSON.stringify({ session_id: 'dns', hook_event_name: 'Stop' }))).code,
      ).toBe(0);
      expect(target.requests).toHaveLength(0);
    } finally {
      target.close();
    }
  });

  // 11. Fan-out delivers in parallel, not sequentially: two unresponsive
  // servers must not make the script wait ~2x the per-server timeout.
  itBuilt('fans out to multiple unresponsive servers in parallel, not sequentially', async () => {
    const hang = (): Promise<{ port: number; close: () => void }> => {
      const server = http.createServer(() => {
        // intentionally never respond
      });
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve({
            port: (server.address() as { port: number }).port,
            close: () => server.close(),
          });
        });
      });
    };
    const a = await hang();
    const b = await hang();
    writeRegistryEntry(process.pid, a.port, 'token-a');
    writeRegistryEntry(process.pid, b.port, 'token-b');

    const start = Date.now();
    const { code } = await runHookScript(
      JSON.stringify({ session_id: 'parallel-timeout', hook_event_name: 'Stop' }),
    );
    const elapsed = Date.now() - start;

    a.close();
    b.close();
    expect(code).toBe(0);
    // Each POST times out at 2s; sequential delivery would take ~4s+. A
    // generous 3.5s ceiling proves the two requests ran concurrently.
    expect(elapsed).toBeLessThan(3500);
  });
});
