import { type ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canBind } from './helpers/bindable.js';

vi.mock('fs', async () => ({ ...(await vi.importActual<typeof import('fs')>('fs')) }));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => process.env['HOME']! };
});
const { PixelAgentsServer } = await import('../src/server.js');
const httpServer = await import('../src/httpServer.js');
const probes = await import('../src/serverProbe.js');
const records = await import('../src/discoveryRecords.js');
const { isServerConfig } = await import('../src/serverConfig.js');
let home: string;
let root: string;
let registry: string;
const servers: InstanceType<typeof PixelAgentsServer>[] = [];
const children: ChildProcess[] = [];
function newServer(): InstanceType<typeof PixelAgentsServer> {
  const server = new PixelAgentsServer();
  servers.push(server);
  return server;
}
const record = () => ({
  pid: process.pid,
  port: 65000,
  token: 'old',
  startedAt: 1,
  servesSpa: false,
  protocol: 1,
});
function read(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** IPC gates acquisition; only the 80 ms release overlaps the synchronous parent.
 * Child stays alive until teardown, so its replacement cannot be pruned as dead. */
async function holdAndReplace(
  files: string[],
  replacement: object,
  marker: string,
): Promise<ChildProcess> {
  const code = `
    const fs = require('fs'), path = require('path'), crypto = require('crypto');
    const [dir, files, replacement, marker] = process.argv.slice(1);
    const lock = path.join(dir, '.discovery.lock');
    fs.writeFileSync(lock, JSON.stringify({pid: process.pid, nonce: crypto.randomUUID()}), {flag: 'wx'});
    process.send('locked');
    process.on('message', () => setTimeout(() => {
      const next = {...JSON.parse(replacement), pid: process.pid};
      for (const file of JSON.parse(files)) fs.writeFileSync(file, JSON.stringify(next));
      fs.writeFileSync(marker, 'released');
      fs.unlinkSync(lock);
    }, 80));
  `;
  const child = spawn(
    process.execPath,
    ['-e', code, registry, JSON.stringify(files), JSON.stringify(replacement), marker],
    {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', (data: Buffer) => {
    stderr += data.toString();
  });
  await new Promise<void>((resolve, reject) => {
    child.once('message', () => resolve());
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`Lock child exited: ${stderr}`)));
  });
  child.send('release-later');
  return child;
}
async function endChild(child: ChildProcess): Promise<void> {
  child.kill();
  if (child.exitCode === null && child.signalCode === null)
    await new Promise((resolve) => child.once('exit', resolve));
}

describe('PixelAgentsServer discovery regressions', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-lifecycle-'));
    vi.stubEnv('HOME', home);
    root = path.join(home, '.pixel-agents');
    registry = path.join(root, 'servers');
    fs.mkdirSync(registry, { recursive: true });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const child of children.splice(0)) await endChild(child);
    for (const server of servers.splice(0)) server.stop();
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it.each(['publication', 'parse/dead prune', 'stale prune', 'stop cleanup'])(
    '%s waits for child publication and preserves its generation (20 iterations)',
    async (mode) => {
      for (let iteration = 0; iteration < 20; iteration++) {
        const server = newServer();
        const marker = path.join(home, `release-${iteration}`);
        let file = path.join(registry, 'child.json');
        let previous = record();
        let child: ChildProcess | undefined;
        const replacement = {
          ...previous,
          token: 'child-generation',
          startedAt: 2,
          host: '192.0.2.1',
        };
        if (mode === 'stop cleanup') {
          previous = await server.start();
          file = path.join(registry, `${previous.pid}-${previous.port}.json`);
          child = await holdAndReplace(
            [file, path.join(root, 'server.json')],
            { ...replacement, port: previous.port },
            marker,
          );
          server.stop();
        } else if (mode === 'parse/dead prune') {
          fs.writeFileSync(
            file,
            iteration % 2 ? 'invalid JSON' : JSON.stringify({ ...previous, pid: 999999 }),
          );
          child = await holdAndReplace([file], replacement, marker);
          await server.start();
        } else if (mode === 'publication') {
          const create = httpServer.createHttpServer;
          vi.spyOn(httpServer, 'createHttpServer').mockImplementationOnce(async (options) => {
            const result = await create(options);
            child = await holdAndReplace([file], replacement, marker);
            return result;
          });
          const own = await server.start();
          expect(read(path.join(registry, `${own.pid}-${own.port}.json`))).toEqual(own);
        } else {
          await server.start(); // Healthy reusable candidate.
          fs.writeFileSync(file, JSON.stringify(previous));
          const probe = probes.probeServer;
          vi.spyOn(probes, 'probeServer').mockImplementation(async (target, timeout) => {
            if (target.port === previous.port) {
              child = await holdAndReplace([file], replacement, marker);
              return 'stale';
            }
            return probe(target, timeout);
          });
          await newServer().start();
        }
        // Without the server.ts lock this check runs BEFORE the child's swap.
        expect(fs.readFileSync(marker, 'utf8')).toBe('released');
        expect(read(file)).toMatchObject({ ...replacement, port: previous.port, pid: child!.pid });
        if (mode === 'stop cleanup')
          expect(read(path.join(root, 'server.json'))).toEqual(read(file));
        vi.restoreAllMocks();
        server.stop();
        await endChild(child!);
        fs.unlinkSync(file);
      }
    },
    60_000,
  );

  it('reuses from a read-only scan under lock contention without pruning', async () => {
    const first = await newServer().start();
    const malformed = path.join(registry, 'malformed.json');
    fs.writeFileSync(malformed, 'invalid');
    const lock = path.join(registry, '.discovery.lock');
    fs.writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, nonce: '12345678-1234-1234-1234-123456789abc' }),
    );
    try {
      expect((await newServer().start()).token).toBe(first.token);
      expect(fs.readFileSync(malformed, 'utf8')).toBe('invalid');
    } finally {
      fs.unlinkSync(lock);
    }
  });

  it('keeps a live PID with a host absent from current local interfaces without probing it', async () => {
    const file = path.join(registry, 'missing-interface.json');
    const entry = { ...record(), host: '192.0.2.1' };
    fs.writeFileSync(file, JSON.stringify(entry));
    const probe = vi.spyOn(probes, 'probeServer');
    await newServer().start();
    expect(read(file)).toEqual(entry);
    expect(probe).not.toHaveBeenCalledWith(expect.objectContaining({ host: entry.host }));
  });

  it('does not prune a record merely because Windows denies its read', async () => {
    const file = path.join(registry, 'unreadable.json');
    fs.writeFileSync(file, JSON.stringify(record()));
    const readFile = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((filename, ...args) => {
      if (filename === file) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
      return readFile(filename, ...args);
    }) as typeof fs.readFileSync);
    await newServer().start();
    expect(fs.existsSync(file)).toBe(true);
  });

  for (const host of ['0.0.0.0', '::']) {
    it(`maps wildcard ${host} to loopback for reusable valid records`, async (context) => {
      if (!(await canBind(host))) context.skip(`Cannot bind ${host} on this runner`);
      const config = await newServer().start({ host });
      expect(config.host).toBe(host === '::' ? '::1' : undefined);
      const file = path.join(registry, `${config.pid}-${config.port}.json`);
      expect(isServerConfig(read(file))).toBe(true);
      expect((await newServer().start()).token).toBe(config.token);
      expect(read(file)).toEqual(config);
    });
  }

  it('publishes registry even if server.json is a directory, then retries legacy', async () => {
    const pointer = path.join(root, 'server.json');
    fs.mkdirSync(pointer);
    const config = await newServer().start();
    const file = path.join(registry, `${config.pid}-${config.port}.json`);
    expect(read(file)).toEqual(config);
    const replacement = { ...config, token: 'replacement', startedAt: config.startedAt + 1 };
    fs.writeFileSync(file, JSON.stringify(replacement));
    fs.rmdirSync(pointer);
    await vi.waitFor(() => expect(read(pointer)).toEqual(config));
    expect(read(file)).toEqual(replacement); // Retry only the failed legacy write.
  });

  it('publishes legacy independently if registry write fails and retries the registry', async () => {
    const write = records.writeDiscoveryRecord;
    const spy = vi.spyOn(records, 'writeDiscoveryRecord').mockImplementation((relative, config) => {
      if (relative.startsWith('servers/')) throw new Error('temporary registry failure');
      write(relative, config);
    });
    const config = await newServer().start();
    expect(read(path.join(root, 'server.json'))).toEqual(config);
    spy.mockRestore();
    await vi.waitFor(() =>
      expect(read(path.join(registry, `${config.pid}-${config.port}.json`))).toEqual(config),
    );
  });

  it('retries publication after contention and cancels retries on stop', async () => {
    const lock = path.join(registry, '.discovery.lock');
    const lockOwner = JSON.stringify({
      pid: process.pid,
      nonce: '12345678-1234-1234-1234-123456789abc',
    });
    fs.writeFileSync(lock, lockOwner);
    const server = newServer();
    const config = await server.start();
    const file = path.join(registry, `${config.pid}-${config.port}.json`);
    expect(fs.existsSync(file)).toBe(false);
    fs.unlinkSync(lock);
    await vi.waitFor(() => expect(read(file)).toEqual(config));
    server.stop();
    const second = newServer();
    fs.writeFileSync(lock, lockOwner);
    const stopped = await second.start();
    second.stop();
    fs.unlinkSync(lock);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fs.existsSync(path.join(registry, `${stopped.pid}-${stopped.port}.json`))).toBe(false);
  });

  it('leaves in-root links and their targets alone during publication, prune and cleanup', async () => {
    const target = path.join(root, 'settings');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'config.json'), 'operator data');
    const pointer = path.join(root, 'server.json');
    const entry = path.join(registry, 'link.json');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(target, pointer, linkType);
    fs.symlinkSync(target, entry, linkType);
    try {
      const server = newServer();
      const config = await server.start();
      expect(read(path.join(registry, `${config.pid}-${config.port}.json`))).toEqual(config);
      server.stop();
      expect(fs.lstatSync(pointer).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(entry).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(target, 'config.json'), 'utf8')).toBe('operator data');
    } finally {
      fs.unlinkSync(pointer);
      fs.unlinkSync(entry);
    }
  });

  it('preserves in-root file symlink targets (when file symlinks are permitted)', async (context) => {
    const target = path.join(root, 'config.json');
    const pointer = path.join(root, 'server.json');
    const entry = path.join(registry, 'file-link.json');
    fs.writeFileSync(target, 'operator settings');
    try {
      fs.symlinkSync(target, pointer, 'file');
    } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        context.skip('File symlinks need Developer Mode or privileges on Windows');
      }
      throw error;
    }
    try {
      fs.symlinkSync(target, entry, 'file');
      const server = newServer();
      const config = await server.start();
      expect(read(path.join(registry, `${config.pid}-${config.port}.json`))).toEqual(config);
      server.stop();
      expect(fs.readFileSync(target, 'utf8')).toBe('operator settings');
      expect(fs.lstatSync(pointer).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(entry).isSymbolicLink()).toBe(true);
    } finally {
      fs.unlinkSync(pointer);
      if (fs.existsSync(entry)) fs.unlinkSync(entry);
    }
  });
});
