import { type ChildProcess, spawn } from 'child_process';

// A worker may die immediately after spawn. This supervisor cannot launch the CLI
// until the worker has durably registered its PID/creation identity and sent ACK.
// It remains alive until the CLI closes, so a dead worker never hides a live CLI.
const supervisor = `
const { spawn } = require('child_process');
let launched = false;
const timer = setTimeout(() => process.exit(1), 10000);
process.on('disconnect', () => { if (!launched) process.exit(1); });
process.once('message', message => {
  if (message !== 'launch') return process.exit(1);
  launched = true; clearTimeout(timer);
  const child = spawn(process.argv[1], process.argv.slice(2), { stdio: 'inherit', windowsHide: true });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; process.disconnect(); });
  child.once('close', code => { process.exitCode = code ?? 1; if (process.connected) process.disconnect(); });
});
`;

export function spawnRegisteredProcess(
  binary: string,
  args: string[],
  cwd: string,
  register?: (pid: number) => void,
): ChildProcess {
  if (!register)
    return spawn(binary, args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const child = spawn(process.execPath, ['-e', supervisor, binary, ...args], {
    cwd,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  child.once('spawn', () => {
    try {
      register(child.pid!);
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
