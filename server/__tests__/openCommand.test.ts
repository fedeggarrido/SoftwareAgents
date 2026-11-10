import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { dispatchCli } from '../src/cli.js';
import { OFFICE_BOOTSTRAP_TTL_MS } from '../src/constants.js';
import { createHttpServer } from '../src/httpServer.js';
import { runOpenCommand } from '../src/openOffice.js';

vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));

let home: string;
let app: Awaited<ReturnType<typeof createHttpServer>>['app'];
const token = 'persistent-secret-never-print-this';
let origin: string;

beforeEach(async () => {
  for (const key of ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])
    vi.stubEnv(key, undefined);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-open-'));
  vi.stubEnv('HOME', home);
  const created = await createHttpServer({ embedded: false, token, store: new AgentStateStore() });
  app = created.app;
  origin = `http://127.0.0.1:${created.port}`;
  fs.mkdirSync(path.join(home, '.pixel-agents'));
  fs.writeFileSync(
    path.join(home, '.pixel-agents', 'server.json'),
    JSON.stringify({
      port: Number(new URL(origin).port),
      pid: process.pid,
      token,
    }),
  );
});

afterEach(async () => {
  await app?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const target = path.resolve(home);
  if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep))
    throw new Error('Invalid test home');
  fs.rmSync(target, { recursive: true, force: true });
});

it('dispatches open and prints only a fresh, expiring, single-use URL', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await dispatchCli(['open', '--no-open']);
  const output = log.mock.calls.flat().join('\n');
  expect(output).toContain('un solo uso, caduca en 60 s');
  expect(output).toContain('Si caduca: pixel-agents open');
  expect(output).not.toContain(token);
  expect(output).not.toContain('?token=');
  const url = new URL(output.match(/http:\/\/\S+/)![0]);
  expect(url.origin).toBe(origin);
  expect([...url.searchParams.keys()]).toEqual(['open']);
  const exchange = () =>
    app.inject({
      method: 'POST',
      url: '/api/office/exchange',
      payload: { code: url.searchParams.get('open') },
    });
  expect((await exchange()).json()).toEqual({ token });
  expect((await exchange()).statusCode).toBe(403);
  log.mockClear();
  await runOpenCommand(['--no-open']);
  const next = new URL(
    log.mock.calls
      .flat()
      .join('\n')
      .match(/http:\/\/\S+/)![0],
  );
  expect(next.href).not.toBe(url.href);
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + OFFICE_BOOTSTRAP_TTL_MS);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/office/exchange',
        payload: { code: next.searchParams.get('open') },
      })
    ).statusCode,
  ).toBe(403);
});

it.each(['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'])(
  'refuses managed marker %s before requesting access',
  async (key) => {
    vi.stubEnv(key, '');
    const fetch = vi.spyOn(globalThis, 'fetch');
    const log = vi.fn();
    await expect(runOpenCommand([], log)).rejects.toThrow('procesos gestionados');
    expect(fetch).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  },
);

it('never prints a persistent token from malformed responses or network errors', async () => {
  const log = vi.fn();
  const fetch = vi.spyOn(globalThis, 'fetch');
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: token })));
  await expect(runOpenCommand(['--no-open'], log)).rejects.toThrow('No se pudo obtener acceso');
  fetch.mockRejectedValueOnce(new Error(`request failed: Bearer ${token}`));
  await expect(runOpenCommand(['--no-open'], log)).rejects.toThrow(
    /^No se pudo obtener acceso[^]*terminal humana\.$/,
  );
  expect(log).not.toHaveBeenCalled();
});

it('authenticates discovery before sending the persistent token', async () => {
  fs.writeFileSync(
    path.join(home, '.pixel-agents', 'server.json'),
    JSON.stringify({
      port: Number(new URL(origin).port),
      pid: process.pid,
      token: 'wrong-secret',
    }),
  );
  const fetch = vi.spyOn(globalThis, 'fetch');
  await expect(runOpenCommand(['--no-open'])).rejects.toThrow('No se pudo obtener acceso');
  expect(fetch).not.toHaveBeenCalled();
});
