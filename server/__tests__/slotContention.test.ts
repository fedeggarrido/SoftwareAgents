import { spawn } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expect, it } from 'vitest';

it('four real processes acquire the last slot 400 times while a fifth reads slots and per-boot publications', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-contention-'));
  const bundle = path.join(home, 'runtime.cjs');
  buildSync({
    stdin: {
      contents: `export * from './executorSlots'; export * from './quotaCommand';
      import { AgentStateStore } from './agentStateStore'; import { MachineCapacityPublisher } from './machineCapacity';
      export const makePublisher = () => new MachineCapacityPublisher(new AgentStateStore(), () => ({}), Date.now, undefined, ['isolated'], () => true);`,
      resolveDir: path.resolve(__dirname, '../src'),
      loader: 'ts',
    },
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  fs.mkdirSync(path.join(home, '.pixel-agents'));
  fs.writeFileSync(
    path.join(home, '.pixel-agents/config.json'),
    JSON.stringify({
      projects: {
        test: {
          autonomyLevel: 'A1',
          allowedExecutors: ['codex'],
          quotaThresholds: { codex: 10 },
          concurrency: { maxExecutions: 1, perExecutor: { codex: 1 } },
        },
      },
    }),
  );
  const children = Array.from({ length: 5 }, () =>
    spawn(
      process.execPath,
      [path.join(__dirname, 'fixtures/slot-contention-process.cjs'), bundle],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: path.join(home, '.codex'),
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true,
      },
    ),
  );
  const exited = children.map((c) => new Promise((resolve) => c.once('exit', resolve)));
  const stderr: string[] = [];
  children.forEach((c) => c.stderr!.on('data', (d) => stderr.push(String(d))));
  const done = children.map(
    (c) =>
      new Promise<{ acquired?: number; errors: string[] }>((resolve, reject) => {
        c.on('message', (m: { ready?: boolean; acquired?: number; errors: string[] }) => {
          if (!m.ready) resolve(m);
        });
        c.on('error', reject);
        c.on('exit', (code) => {
          if (code) reject(new Error(stderr.join('')));
        });
      }),
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.all(children.map((c) => new Promise((resolve) => c.once('message', resolve))));
    children[4].send({ role: 'reader' });
    children.slice(0, 4).forEach((c) => c.send({ role: 'writer', iterations: 100 }));
    const writers = await Promise.race([
      Promise.all(done.slice(0, 4)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('contention deadline')), 90000);
      }),
    ]);
    children[4].send({ stop: true });
    const reader = await done[4];
    expect(writers.flatMap((r) => r.errors)).toEqual([]);
    expect(writers.map((r) => r.acquired)).toEqual([100, 100, 100, 100]);
    expect(reader.errors).toEqual([]);
    expect(stderr).toEqual([]);
    await Promise.all(exited);
  } finally {
    if (timer) clearTimeout(timer);
    children.forEach((c) => {
      if (c.exitCode === null) c.kill();
    });
    await Promise.all(exited);
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 120000);
