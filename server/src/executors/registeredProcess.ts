import { type ChildProcess, spawn } from 'child_process';

import { MANAGED_EXECUTION_ENV } from '../evalGuard.js';

// A worker may die immediately after spawn. This supervisor cannot launch the CLI
// until the worker has durably registered its PID/creation identity and sent ACK.
// After CLI close it waits for a durable-close ACK. A disconnected worker leaves
// this verifiable root alive for SA-026, even if the CLI has already exited.
const supervisor = `
const { spawn } = require('child_process');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
let launched = false;
let closed = false;
let exitCode = 1;
const timer = setInterval(() => { if (!launched) process.exit(1); }, 10000);
process.on('disconnect', () => { if (!launched) process.exit(1); });
process.on('message', message => {
  if (message === 'release' && closed) {
    clearInterval(timer);
    process.exitCode = exitCode;
    if (process.connected) process.disconnect();
    return;
  }
  if (launched) return;
  if (message !== 'launch') return process.exit(1);
  launched = true;
  const child = spawn(process.argv[1], process.argv.slice(2), { stdio: 'inherit', windowsHide: true });
  child.once('error', () => {
    if (process.connected) process.send({ type: 'spawn_error' }, () => {});
  });
  child.once('close', code => {
    closed = true; exitCode = code ?? 1;
    if (process.connected) process.send('cli_closed', () => {});
  });
});
`;

export function spawnRegisteredProcess(
  binary: string,
  args: string[],
  cwd: string,
  register?: (pid: number) => void | Promise<void>,
  persistClose?: () => void | Promise<void>,
  environment?: NodeJS.ProcessEnv,
): ChildProcess {
  if (!register)
    return spawn(binary, args, {
      cwd,
      env: { ...process.env, ...environment, [MANAGED_EXECUTION_ENV]: 'worker' },
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const child = spawn(process.execPath, ['-e', supervisor, binary, ...args], {
    cwd,
    env: { ...process.env, ...environment, [MANAGED_EXECUTION_ENV]: 'worker' },
    windowsHide: true,
    // UV_PROCESS_DETACHED keeps Windows out of libuv's worker-owned
    // KILL_ON_JOB_CLOSE job. Keep windowsHide as well: no console window.
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  child.on('message', async (message) => {
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'spawn_error'
    ) {
      // Forward a fixed diagnostic, never a binary path or the supervisor argv.
      child.emit('error', new Error('Executor spawn failed'));
      return;
    }
    if (message !== 'cli_closed') return;
    try {
      await persistClose?.();
      if (child.connected) child.send('release', () => {});
    } catch (error) {
      // Do not release the registered root when persistence failed. The executor
      // timeout/cancellation or SA-026 must reconcile it before reuse.
      child.emit('error', error);
    }
  });
  child.once('spawn', async () => {
    try {
      await register(child.pid!);
      child.send('launch');
    } catch (error) {
      // Before ACK there is no executor: the supervisor has launched nothing, so
      // killing it is safe. Never disconnect here: when the supervisor then exits on
      // its own, Node emits 'exit' but never 'close', and the executor adapters,
      // which drain close/finished to release the slot and lock, would wait forever.
      child.emit('error', error);
      child.kill();
    }
  });
  return child;
}
