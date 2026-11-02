import { type ChildProcess, spawn } from 'child_process';

import { MANAGED_EXECUTION_ENV } from '../evalGuard.js';
import { OPERATOR_TOKEN_ENV, withoutOperatorToken } from '../featureIngress.js';
import { WINDOWS_JOB_LAUNCH } from './windowsJob.js';

// A worker may die immediately after spawn. This supervisor cannot launch the CLI
// until the worker has durably registered its PID/creation identity and sent ACK.
// After CLI close it waits for a durable-close ACK. A disconnected worker leaves
// this verifiable root alive for SA-026, even if the CLI has already exited.
const supervisor = `
const { spawn } = require('child_process');
const OPERATOR_TOKEN_ENV = ${JSON.stringify(OPERATOR_TOKEN_ENV)};
const withoutOperatorToken = env => Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== OPERATOR_TOKEN_ENV));
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
let launched = false;
let closed = false;
let exitCode = 1;
let job;
const timer = setInterval(() => { if (!launched) process.exit(1); }, 10000);
process.on('disconnect', () => { if (!launched) process.exit(1); });
process.on('message', message => {
  if (message === 'cancel') {
    if (job) job.stdin.write('cancel\\n');
    else process.exit(130);
    return;
  }
  if (message === 'release' && closed) {
    clearInterval(timer);
    process.exitCode = exitCode;
    if (process.connected) process.disconnect();
    return;
  }
  if (launched) return;
  if (message !== 'launch') return process.exit(1);
  launched = true;
  const launch = () => {
  const child = spawn(process.argv[1], process.argv.slice(2), { env: withoutOperatorToken(process.env), stdio: 'inherit', windowsHide: true });
  child.once('error', () => {
    if (process.connected) process.send({ type: 'spawn_error' }, () => {});
  });
  child.once('close', code => {
    closed = true; exitCode = code ?? 1;
    if (job) job.stdin.write('drain\\n');
    else if (process.connected) process.send('cli_closed', () => {});
  });
  };
  if (process.platform !== 'win32') return launch();
  job = spawn(process.env.SystemRoot + '\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe',
    ['-NoProfile','-NonInteractive','-EncodedCommand', ${JSON.stringify(Buffer.from(WINDOWS_JOB_LAUNCH, 'utf16le').toString('base64'))}],
    { windowsHide: true, env: withoutOperatorToken({...process.env, SA_JOB_ROOT: String(process.pid)}), stdio: ['pipe','pipe','ignore'] });
  let ready = false;
  job.stdin.on('error', () => process.exit(1));
  require('readline').createInterface({input:job.stdout}).on('line', line => {
    if (line === 'JOB_READY' && !ready) { ready=true; launch(); }
    if (line === 'JOB_DRAINED' && closed && process.connected) process.send('cli_closed', () => {});
  });
  job.on('error', () => process.exit(1));
  job.on('exit', () => process.exit(1));
  // These pipes must not keep the root alive after the durable-close ACK.
  job.unref(); job.stdin.unref(); job.stdout.unref();
});
`;

const managedWindowsProcesses = new WeakSet<ChildProcess>();

/** Cancel through the retained supervisor IPC channel; never reopen a PID. */
export function cancelRegisteredProcess(child: ChildProcess): boolean {
  if (!managedWindowsProcesses.has(child)) return false;
  if (child.connected)
    child.send('cancel', (error) => {
      if (error) child.kill();
    });
  else child.kill(); // Job owner observes the retained root handle's exit.
  return true;
}

export function spawnRegisteredProcess(
  binary: string,
  args: string[],
  cwd: string,
  register?: (pid: number) => void | Promise<void>,
  persistClose?: () => void | Promise<void>,
  environment?: NodeJS.ProcessEnv,
): ChildProcess {
  if (!register && process.platform !== 'win32')
    return spawn(binary, args, {
      cwd,
      env: withoutOperatorToken({
        ...process.env,
        ...environment,
        [MANAGED_EXECUTION_ENV]: 'worker',
      }),
      windowsHide: true,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const child = spawn(process.execPath, ['-e', supervisor, binary, ...args], {
    cwd,
    env: withoutOperatorToken({
      ...process.env,
      ...environment,
      [MANAGED_EXECUTION_ENV]: 'worker',
    }),
    windowsHide: true,
    // UV_PROCESS_DETACHED keeps Windows out of libuv's worker-owned
    // KILL_ON_JOB_CLOSE job. Keep windowsHide as well: no console window.
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  if (process.platform === 'win32') managedWindowsProcesses.add(child);
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
      await register?.(child.pid!);
      child.send('launch');
    } catch (error) {
      // Before ACK there is no executor: the supervisor has launched nothing, so
      // killing it is safe. Never disconnect here: when the supervisor then exits on
      // its own, Node emits 'exit' but never 'close', and the executor adapters,
      // which drain close/finished to release the slot and lock, would wait forever.
      try {
        child.emit('error', error);
      } finally {
        child.kill();
      }
    }
  });
  return child;
}
