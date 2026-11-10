import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { ClientMessage, ServerMessage } from '../../core/src/messages.js';
import { CliArgsError, dispatchCli, parseArgs } from '../src/cli.js';
import { CLAUDE_HOOK_EVENTS } from '../src/providers/hook/claude/constants.js';
import { operatorTokenServer } from './helpers/operatorToken.js';

const CLI_BUNDLE = path.join(__dirname, '../../dist/cli.js');
const CLI_START_TIMEOUT_MS = 10_000;
let proofServer: Awaited<ReturnType<typeof operatorTokenServer>> | undefined;

describe('SA-115 top-level help', () => {
  it('accepts the explicit --no-open switch', () => {
    expect(parseArgs(['--no-open', '--port', '3100'])).toMatchObject({ noOpen: true, port: 3100 });
  });
  it('documents every dispatched subcommand in the actual --help output', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exited = new Error('help exited');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw exited;
    });
    try {
      expect(() => parseArgs(['--help'])).toThrow(exited);
      expect(exit).toHaveBeenCalledWith(0);
      const help = log.mock.calls.map(([line]) => String(line)).join('\n');
      // Read the real dispatcher, so adding another branch without help fails this test.
      // The IPC-only --design-capture-host flag is not a public subcommand.
      const commands = [
        ...dispatchCli.toString().matchAll(/argv\[0\]\s*===\s*['"]([a-z][a-z0-9-]*)['"]/g),
      ].map((match) => match[1]);
      expect(commands).toContain('feature');
      expect(commands).toContain('project');
      const documented = [...help.matchAll(/^  ([a-z][a-z0-9-]*)\s+\S[^\n]+$/gm)].map(
        (match) => match[1],
      );
      expect(documented.sort()).toEqual(commands.sort());
      expect(help).toContain('project init');
      expect(help).toContain('Preparar el proyecto');
    } finally {
      log.mockRestore();
      exit.mockRestore();
    }
  });
});

afterEach(async () => {
  await proofServer?.close();
  proofServer = undefined;
  vi.unstubAllEnvs();
});

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate a test port'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForCondition(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + CLI_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for bundled CLI startup');
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('close', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

/** Run the real bundled CLI as a subprocess, returns exit code + output. */
function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI_BUNDLE, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('parseArgs', () => {
  // 1. No --port -> ephemeral default (unset), never a hardcoded port
  it('defaults port to undefined (ephemeral) when --port is omitted', () => {
    const args = parseArgs([]);
    expect(args.port).toBeUndefined();
    expect(args.host).toBe('127.0.0.1');
  });

  // 2. Valid --port is accepted
  it('accepts a valid --port', () => {
    expect(parseArgs(['--port', '3100']).port).toBe(3100);
    expect(parseArgs(['-p', '8080']).port).toBe(8080);
  });

  // 3. Boundary values are accepted
  it('accepts the boundary ports 1 and 65535', () => {
    expect(parseArgs(['--port', '1']).port).toBe(1);
    expect(parseArgs(['--port', '65535']).port).toBe(65535);
  });

  // 4. Non-numeric --port is rejected (would otherwise become NaN)
  it('rejects a non-numeric --port instead of producing NaN', () => {
    expect(() => parseArgs(['--port', 'not-a-number'])).toThrow(CliArgsError);
  });

  // 5. Zero is rejected (0 means "ephemeral" internally; not a valid explicit choice)
  it('rejects --port 0', () => {
    expect(() => parseArgs(['--port', '0'])).toThrow(CliArgsError);
  });

  // 6. Out-of-range (too high) is rejected
  it('rejects --port 70000 (out of TCP range)', () => {
    expect(() => parseArgs(['--port', '70000'])).toThrow(CliArgsError);
  });

  // 7. Negative is rejected
  it('rejects a negative --port', () => {
    expect(() => parseArgs(['--port', '-1'])).toThrow(CliArgsError);
  });

  // 8. Non-integer (decimal) is rejected
  it('rejects a decimal --port', () => {
    expect(() => parseArgs(['--port', '3100.5'])).toThrow(CliArgsError);
  });

  // 9. A port option without its required operand is rejected, not ignored
  it.each(['--port', '-p'])('rejects %s when its value is missing', (option) => {
    expect(() => parseArgs([option])).toThrow(CliArgsError);
    expect(() => parseArgs([option])).toThrow(/Missing value/);
  });

  // 10. --host is parsed independently of --port
  it('parses --host', () => {
    expect(parseArgs(['--host', '0.0.0.0']).host).toBe('0.0.0.0');
  });
});

// The TTY consent prompt is gone: first-run consent is asked in the app, as
// one step of the Intro (the server's hooksConsentRequest → the webview's
// IntroBubble, whose consent step renders it verbatim). Its two pinned
// semantics moved with it: "junk must never be read as approval" now lives in
// consentFlow.test.ts (an unrecognized hooksConsentResponse choice
// writes nothing), and the disclosure-content pins live in consentCopy.test.ts
// plus the handshake test asserting the request carries that copy verbatim.

/**
 * These spawn the real bundled dist/cli.js (built by esbuild), not the TS
 * source -- unlike the parseArgs tests above (which only prove importing the
 * module for its exports is side-effect-free), these prove the
 * `require.main === module` guard added to cli.ts still lets `main()` run
 * when the file IS executed directly, i.e. production behavior is intact.
 * Requires `npm run compile` (or `node esbuild.js`) to have produced
 * dist/cli.js first; reported as a loud skip if it hasn't.
 */
describe('dist/cli.js entry-point guard', () => {
  /** These tests spawn the BUNDLED CLI, so they need `npm run compile` to have
   *  run. Reported as a loud skip rather than an early `return`, which Vitest
   *  shows as PASSED with no message — a false green over a test that never
   *  exercised anything. */
  const itBuilt = it.skipIf(!fs.existsSync(CLI_BUNDLE));

  itBuilt.each([
    ['broken YAML', 'brain: [', '/project.yaml'],
    ['invalid schema', '{}', '/apiVersion'],
    [
      'escaping path',
      JSON.stringify({
        apiVersion: 'softwareagents.io/v1alpha1',
        kind: 'Project',
        id: 'sample',
        name: 'Sample',
        repo: { remote: 'https://example.com/sample.git', defaultBranch: 'main' },
        brain: { path: '../outside' },
      }),
      '/brain/path',
    ],
  ])('starts the office with %s in project.yaml', async (_name, manifest, field) => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-invalid-'));
    await runCliServer(
      tmpHome,
      async ({ output }) => {
        expect(output()).toContain(
          '[Pixel Agents] Ignoring company board: invalid .softwareagents/project.yaml: ',
        );
        expect(output()).toContain(field);
      },
      '127.0.0.1',
      (workspace) => {
        fs.mkdirSync(path.join(workspace, '.softwareagents'));
        fs.writeFileSync(path.join(workspace, '.softwareagents/project.yaml'), manifest);
        fs.mkdirSync(path.join(workspace, 'docs/backlog'), { recursive: true });
        fs.writeFileSync(path.join(workspace, 'docs/backlog/board.json'), '{"items":[]}');
      },
    );
  });

  // 11. Direct execution still runs main() (--help exits 0 with usage)
  itBuilt('runs main() when executed directly: --help prints usage and exits 0', async () => {
    const { code, stdout } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Uso: pixel-agents');
  });

  // 12. Direct execution still runs main()'s port validation (rejects before listen())
  itBuilt(
    'runs main() when executed directly: invalid --port exits 1 without starting a server',
    async () => {
      const { code, stderr } = await runCli(['--port', 'not-a-number']);
      expect(code).toBe(1);
      expect(stderr).toContain('Invalid --port');
    },
  );

  itBuilt(
    'office stays healthy with rejected Operator tiers; worker/quota exit 1 without traces',
    async () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-tiers-'));
      fs.mkdirSync(path.join(tmpHome, '.pixel-agents'));
      fs.writeFileSync(
        path.join(tmpHome, '.pixel-agents/config.json'),
        JSON.stringify({
          projects: {
            sample: {
              autonomyLevel: 'A1',
              allowedExecutors: ['claude'],
              modelTiers: { maxTier: 'deep', tiers: {} },
            },
            other: { autonomyLevel: 'A1', allowedExecutors: ['codex'] },
          },
        }),
      );
      await runCliServer(
        tmpHome,
        async ({ output, port }) => {
          expect((await fetch(`http://127.0.0.1:${port}/api/health`)).ok).toBe(true);
          expect(output()).toContain('Rejected Operator project sample');
          proofServer = await operatorTokenServer(tmpHome);
          const workspace = path.join(tmpHome, 'commands');
          fs.mkdirSync(path.join(workspace, '.softwareagents'), { recursive: true });
          fs.writeFileSync(
            path.join(workspace, '.softwareagents/project.yaml'),
            JSON.stringify({
              apiVersion: 'softwareagents.io/v1alpha1',
              kind: 'Project',
              id: 'sample',
              name: 'Sample',
              repo: { remote: 'https://example.invalid/sample.git', defaultBranch: 'main' },
              brain: { path: '.softwareagents/brain' },
            }),
          );
          for (const args of [
            ['quota', 'check', '--select-executor', '--role', 'developer'],
            ['worker', 'run', '--task', 'SA-999', '--brief', 'absent.md'],
            ['quota', 'check'],
            ['worker', 'run'],
          ]) {
            const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
              // worker run is a human decision (SA-107): confirm with the live proof server's
              // token, as the operator would, and without managed-execution markers.
              const operatorEnv = Object.fromEntries(
                Object.entries(process.env).filter(
                  ([key]) =>
                    !['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'].includes(
                      key,
                    ),
                ),
              );
              const token = JSON.parse(
                fs.readFileSync(path.join(tmpHome, '.pixel-agents', 'server.json'), 'utf8'),
              ).token as string;
              const child = spawn(process.execPath, [CLI_BUNDLE, ...args], {
                cwd: workspace,
                env: {
                  ...operatorEnv,
                  HOME: tmpHome,
                  USERPROFILE: tmpHome,
                  CODEX_HOME: path.join(tmpHome, 'codex'),
                  PIXEL_AGENTS_OPERATOR_TOKEN: token,
                },
                stdio: ['ignore', 'pipe', 'pipe'],
              });
              let stderr = '';
              child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
              child.on('close', (code) => resolve({ code, stderr }));
            });
            expect(result.code).toBe(1);
            expect(result.stderr).not.toMatch(/\n\s+at /);
            if (args.length > 2)
              expect(result.stderr).toContain(
                args[0] === 'worker' && process.platform !== 'win32'
                  ? 'worker run requires Windows'
                  : 'Invalid Operator modelTiers',
              );
          }
        },
        '127.0.0.1',
      );
    },
  );

  /** Spawn the real bundled CLI against an isolated HOME, wait for /api/health,
   *  and hand back its output for assertions. Callers seed `tmpHome` first.
   *  `host` is the literal `--host` operand, so a caller can exercise a wildcard
   *  bind; readiness is always probed over loopback, which every bind serves. */
  async function runCliServer(
    tmpHome: string,
    body: (ctx: { output: () => string; port: number }) => Promise<void>,
    host = '127.0.0.1',
    seedWorkspace?: (workspace: string) => string | void,
  ): Promise<void> {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-workspace-'));
    const startupDir = seedWorkspace?.(workspaceDir) ?? workspaceDir;
    const port = await getFreePort();
    const child = spawn(process.execPath, [CLI_BUNDLE, '--port', port.toString(), '--host', host], {
      cwd: startupDir,
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    try {
      await waitForCondition(async () => {
        if (child.exitCode !== null) {
          throw new Error(`Bundled CLI exited before startup:\n${output}`);
        }
        try {
          return (await fetch(`http://127.0.0.1:${port.toString()}/api/health`)).ok;
        } catch {
          return false;
        }
      });
      await body({ output: () => output, port });
    } finally {
      await stopChild(child);
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  }

  /** The one line a standalone operator ever sees. Kept as a real regex over
   *  the real stdout, because a helper that reassembled the URL from parts
   *  would be testing the helper. The trailing `\s` makes it wait for a
   *  complete line: stdout arrives in chunks, and a half-delivered URL still
   *  parses as a URL (`http://127.0.0.1:501`). */
  const URL_LINE = /Pixel Agents server running at (\S+)\s/;

  function printedUrl(output: string): URL {
    const match = URL_LINE.exec(output);
    if (!match?.[1]) throw new Error(`No server URL in CLI output:\n${output}`);
    return new URL(match[1]);
  }

  /** The token the server actually minted, read from its own discovery file —
   *  an independent witness, so a printed token that drifts from it fails. */
  function mintedToken(tmpHome: string): string {
    const raw = fs.readFileSync(path.join(tmpHome, '.pixel-agents', 'server.json'), 'utf-8');
    return (JSON.parse(raw) as { token: string }).token;
  }

  itBuilt(
    'rebinds the running office and all connected snapshots after preparing from a subdirectory',
    async () => {
      for (const marker of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
        vi.stubEnv(marker, undefined);
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-preparation-'));
      await runCliServer(
        tmpHome,
        async ({ output, port }) => {
          await waitForCondition(() => URL_LINE.test(output()));
          const messages: ServerMessage[][] = [[], []];
          const sockets: WebSocket[] = [];
          try {
            for (const received of messages) {
              const socket = new WebSocket(
                `ws://127.0.0.1:${port}/ws?token=${mintedToken(tmpHome)}`,
              );
              sockets.push(socket);
              socket.on('message', (data) =>
                received.push(JSON.parse(data.toString()) as ServerMessage),
              );
              await new Promise<void>((resolve, reject) => {
                socket.once('open', resolve);
                socket.once('error', reject);
              });
              socket.send(
                JSON.stringify({ type: 'webviewReady', capabilities: ['executorControls'] }),
              );
              await waitForCondition(() =>
                received.some((message) => message.type === 'existingAgents'),
              );
              expect(received.some((message) => message.type === 'executorState')).toBe(false);
            }
            sockets[0].send(
              JSON.stringify({
                type: 'prepareProject',
                requestId: 'prepare',
                name: 'Prepared project',
              }),
            );
            await waitForCondition(() =>
              messages[0].some((message) => message.type === 'prepareProjectResult'),
            );
            const result = messages[0].find((message) => message.type === 'prepareProjectResult');
            expect(result).toMatchObject({ status: 'created', errorCode: null });
            if (result?.type !== 'prepareProjectResult' || !result.projectId)
              throw new Error('Project creation did not return an identity');
            const projectId = result.projectId;
            for (const received of messages) {
              await waitForCondition(() =>
                received.some((message) => message.type === 'executorState'),
              );
              expect(received.find((message) => message.type === 'executorState')).toMatchObject({
                projectId,
              });
              expect(received.find((message) => message.type === 'workSnapshot')).toMatchObject({
                projectId,
                source: 'missing',
              });
              await waitForCondition(() =>
                received.some(
                  (message) => message.type === 'boardState' && message.projectId === projectId,
                ),
              );
              expect(
                received.filter((message) => message.type === 'boardState').at(-1),
              ).toMatchObject({ projectId, mode: 'project', project: 'Prepared project' });
            }
            const requests: ClientMessage[] = [
              { type: 'requestFeatures', requestId: 'features', projectId },
              { type: 'requestAuditLog', requestId: 'audit', projectId },
            ];
            for (const request of requests) sockets[1].send(JSON.stringify(request));
            // The refreshed PR monitor initializes the WorkStore asynchronously.
            await waitForCondition(() => {
              sockets[1].send(JSON.stringify(requests[0]));
              return messages[1].some(
                (message) => message.type === 'featuresSnapshot' && message.status === 'empty',
              );
            });
            await waitForCondition(() =>
              messages[1].some((message) => message.type === 'auditLog'),
            );
            expect(
              messages[1].find(
                (message) => message.type === 'featuresSnapshot' && message.status === 'empty',
              ),
            ).toMatchObject({ projectId, status: 'empty', reason: null });
            expect(messages[1].find((message) => message.type === 'auditLog')).toMatchObject({
              projectId,
              status: 'ok',
              totalValid: 2,
            });
          } finally {
            for (const socket of sockets) socket.terminate();
          }
        },
        '127.0.0.1',
        (workspace) => {
          execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
            cwd: workspace,
            windowsHide: true,
            stdio: 'pipe',
          });
          const nested = path.join(workspace, 'nested');
          fs.mkdirSync(nested);
          return nested;
        },
      );
    },
  );

  // Interactive startup passes the capability directly to the browser opener.
  // The printed address must be public and safe to retain in logs.
  itBuilt('prints only a public URL without logging the persistent token', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-url-'));
    await runCliServer(tmpHome, async ({ output, port }) => {
      await waitForCondition(() => URL_LINE.test(output()));
      const url = printedUrl(output());

      expect(url.searchParams.has('token')).toBe(false);
      expect(output()).not.toContain(mintedToken(tmpHome));
      expect(url.port).toBe(port.toString());
      // And it is browsable as printed — the SPA, not a 404 or a dead host.
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<div id="root">');
    });
  });

  // `--host 0.0.0.0` is a BIND target, not an address to browse to: printing
  // `http://0.0.0.0:PORT` hands the operator a URL that is dead on Windows and
  // merely accidental elsewhere (macOS happens to route it to loopback, so
  // "does it load" alone would not catch this — hence the explicit check that
  // the DISPLAYED host is a loopback address). `::` and `''` take the same
  // branch and are left untested here: binding them needs IPv6 on the runner,
  // which is not a property of ours to depend on.
  itBuilt('prints a reachable loopback host when bound to the 0.0.0.0 wildcard', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-wildcard-'));
    await runCliServer(
      tmpHome,
      async ({ output }) => {
        await waitForCondition(() => URL_LINE.test(output()));
        const url = printedUrl(output());

        expect(url.hostname).not.toBe('0.0.0.0');
        expect(['127.0.0.1', 'localhost', '[::1]', '::1']).toContain(url.hostname);
        // Public wildcard output must also keep the capability out of logs.
        expect(url.searchParams.has('token')).toBe(false);
        expect(output()).not.toContain(mintedToken(tmpHome));
        expect((await fetch(url)).status).toBe(200);
      },
      '0.0.0.0',
    );
  });

  // Without consent the CLI must start normally and touch nothing — the ask
  // happens in the browser UI, never at startup. This is the inverse of the
  // seeded test below: it pins that the gate actually gates, rather than the
  // install happening to work.
  itBuilt('starts without touching settings.json when consent has not been given', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-noconsent-'));
    await runCliServer(tmpHome, async ({ output }) => {
      // Give the startup consent/install path time to have run (it is awaited
      // before the "server running" line, which health readiness follows).
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(fs.existsSync(path.join(tmpHome, '.claude', 'settings.json'))).toBe(false);
      expect(output()).toContain('Hooks pendientes de aprobación');
    });
  });

  // An existing user whose hooks a pre-consent version installed gets ZERO
  // friction: no prompt, just the migration. The startup install is the 14 -> 12
  // migration and it only ever REDUCES scope (UserPromptSubmit and TaskCreated,
  // the two events that forwarded prompt text, go away), so asking would buy
  // this user nothing they do not already have. What it must NOT do is take the
  // opportunity to touch anything else: unrelated settings keys and a
  // third-party hook sharing one of our entries both survive intact.
  itBuilt('migrates a pre-consent install to 12 events with no prompt', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-legacy-'));
    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    // A legacy install: our command on every event we install today, plus the
    // two we no longer do.
    const ourCommand = `node "${path.join(tmpHome, '.pixel-agents', 'hooks', 'claude-hook.js')}"`;
    const thirdPartyCommand = 'node /elsewhere/other-tool.js';
    const legacyEvents = [...CLAUDE_HOOK_EVENTS, 'UserPromptSubmit', 'TaskCreated'];
    const hooks = Object.fromEntries(
      legacyEvents.map((event) => [
        event,
        [{ matcher: '', hooks: [{ type: 'command', command: ourCommand, timeout: 5 }] }],
      ]),
    ) as Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
    // A third-party hook sharing the entry of an event we are dropping: the
    // sweep must take ours out of it and leave theirs.
    hooks['UserPromptSubmit'][0].hooks.unshift({ command: thirdPartyCommand });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks }, null, 2),
    );

    await runCliServer(tmpHome, async ({ output }) => {
      await waitForCondition(() => output().includes('[Pixel Agents] Hooks installed'));
      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
        permissions?: unknown;
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      const ourEvents = Object.entries(after.hooks)
        .filter(([, entries]) => entries.some((e) => e.hooks.some((h) => h.command === ourCommand)))
        .map(([event]) => event)
        .sort();
      expect(ourEvents).toEqual([...CLAUDE_HOOK_EVENTS].sort());
      expect(ourEvents).not.toContain('UserPromptSubmit');
      expect(ourEvents).not.toContain('TaskCreated');
      // Untouched neighbours: an unrelated top-level key, and the third-party
      // hook that shared the entry we swept.
      expect(after.permissions).toEqual({ allow: ['Bash(ls:*)'] });
      expect(after.hooks['UserPromptSubmit'][0].hooks).toEqual([{ command: thirdPartyCommand }]);
      // TaskCreated held only ours -> emptied and the key removed entirely.
      expect(after.hooks['TaskCreated']).toBeUndefined();

      const configPath = path.join(tmpHome, '.pixel-agents', 'config.json');
      const consent = (
        JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
          hooksConsent?: Record<string, string>;
        }
      ).hooksConsent?.claude;
      expect(consent).toBe('granted');

      // ZERO friction: nothing that reads as a question or a deferral was
      // printed. The prompt headline, the [Y/n/never] question, and both
      // no-consent notices would each be a prompt this user must not see.
      expect(output()).not.toContain('needs to add its hooks');
      expect(output()).not.toContain('[Y/n/never]');
      expect(output()).not.toContain('Hooks pendientes de aprobación');
      expect(output()).not.toContain('asked again next time');
    });
  });

  // W5: the hook script is copied BEFORE the settings entries, and a failed
  // copy aborts the install. An entry pointing at a script that does not exist
  // makes Claude Code spawn a dead `node` for every event — worse than nothing.
  // A regular file where the hooks DIRECTORY belongs makes the copy fail
  // (ENOTDIR) without touching the repo's real dist/.
  itBuilt('writes no hook entries when the hook script cannot be copied', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-nocopy-'));
    fs.mkdirSync(path.join(tmpHome, '.pixel-agents'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.pixel-agents', 'config.json'),
      JSON.stringify({ hooksConsent: { claude: 'granted' } }),
    );
    // hooks/ is a FILE, so copying into hooks/claude-hook.js fails.
    fs.writeFileSync(path.join(tmpHome, '.pixel-agents', 'hooks'), 'not a directory');

    await runCliServer(tmpHome, async ({ output }) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(fs.existsSync(path.join(tmpHome, '.claude', 'settings.json'))).toBe(false);
      expect(output()).toContain('Hooks NOT installed');
      expect(output()).not.toContain('[Pixel Agents] Hooks installed');
    });
  });

  itBuilt('installs the bundled hook script from the package root on startup', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-home-'));
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-workspace-'));
    // The spawned CLI has no TTY, and without prior consent the first-run gate
    // (rightly) skips hook installation there — seed consent so this test can
    // exercise the actual install path.
    fs.mkdirSync(path.join(tmpHome, '.pixel-agents'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.pixel-agents', 'config.json'),
      JSON.stringify({ hooksConsent: { claude: 'granted' } }),
    );
    const port = await getFreePort();
    const child = spawn(
      process.execPath,
      [CLI_BUNDLE, '--port', port.toString(), '--host', '127.0.0.1'],
      {
        cwd: workspaceDir,
        env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));

    try {
      await waitForCondition(async () => {
        if (child.exitCode !== null) {
          throw new Error(`Bundled CLI exited before startup:\n${output}`);
        }
        try {
          return (await fetch(`http://127.0.0.1:${port.toString()}/api/health`)).ok;
        } catch {
          return false;
        }
      });

      const installedHook = path.join(tmpHome, '.pixel-agents', 'hooks', 'claude-hook.js');
      await waitForCondition(() => fs.existsSync(installedHook));
      expect(fs.readFileSync(installedHook, 'utf-8')).toContain('#!/usr/bin/env node');
      if (process.platform !== 'win32') {
        expect(fs.statSync(installedHook).mode & 0o100).toBeTruthy();
      }

      const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      // JSON.stringify escapes Windows backslashes; inspect the parsed command.
      const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      expect(hooks.SessionStart[0].hooks[0].command).toBe(`node "${installedHook}"`);
    } finally {
      await stopChild(child);
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
