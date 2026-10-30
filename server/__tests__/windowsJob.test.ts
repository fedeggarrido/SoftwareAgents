import { execFile } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { processCancellation } from '../src/executors/processCancellation.js';
import { spawnRegisteredProcess } from '../src/executors/registeredProcess.js';
import { processStartIdentity } from '../src/workstore/processRecovery.js';
import { windowsTerminationScript } from '../src/workstore/windowsProcessRecovery.js';

it
  .skipIf(process.platform !== 'win32' || process.env.SA_SKIP_TASKKILL_TEST === '1')
  .each(['exit', 'cancel'] as const)(
  'retains closure while an orphan descendant lives, then handles %s',
  async (mode) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-job-drain-'));
    const ready = path.join(dir, 'ready');
    const release = path.join(dir, 'release');
    const descendant = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t);}},10);`;
    const cli = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',windowsHide:true,detached:true}).unref();`;
    let persisted = false;
    const root = spawnRegisteredProcess(
      process.execPath,
      ['-e', cli],
      dir,
      () => {},
      () => {
        persisted = true;
      },
    );
    root.stdout!.resume();
    root.stderr!.resume();
    root.stdin!.end();
    const exited = once(root, 'exit');
    try {
      const deadline = Date.now() + 20000;
      while (!fs.existsSync(ready) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fs.existsSync(ready)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(persisted).toBe(false);
      expect(root.exitCode).toBeNull();
      if (mode === 'exit') fs.writeFileSync(release, 'release');
      else processCancellation(() => root).cancel();
      await exited;
      expect(persisted).toBe(mode === 'exit');
    } finally {
      if (root.exitCode === null && root.signalCode === null) root.kill();
      await exited;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  40000,
);

it.skipIf(process.platform !== 'win32' || process.env.SA_SKIP_TASKKILL_TEST === '1')(
  'recovery kills a grandchild born after recovery captured the root and Job handles',
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-job-'));
    const go = path.join(dir, 'go');
    const pidFile = path.join(dir, 'pid');
    const ready = path.join(dir, 'ready');
    const late = `const fs=require('fs'); const t=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(go)}))return;clearInterval(t);const p=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(pidFile)},String(p.pid));},10);`;
    const cli = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(late)}],{stdio:'ignore',windowsHide:true});require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`;
    let identity: string | null = null;
    const root = spawnRegisteredProcess(process.execPath, ['-e', cli], dir, async (pid) => {
      identity = await processStartIdentity(pid);
    });
    root.stdout!.resume();
    root.stderr!.resume();
    root.stdin!.end();
    const errors: Error[] = [];
    root.on('error', (error) => errors.push(error));
    const exited = once(root, 'exit');
    try {
      const deadline = Date.now() + 20000;
      while (!fs.existsSync(ready) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(errors).toEqual([]);
      expect(fs.existsSync(ready)).toBe(true);
      // Instrument only the fixture invocation, after production pins both handles.
      // There is deliberately no descendant snapshot: the Job owns future children too.
      const quoted = (file: string) => `'${file.replace(/'/g, "''")}'`;
      const script = windowsTerminationScript(root.pid!, identity!).replace(
        'try { [ExecutionJob]::Kill($job);',
        `try { [IO.File]::WriteAllText(${quoted(go)},'go');
          $deadline=[DateTime]::UtcNow.AddSeconds(10)
          while (-not [IO.File]::Exists(${quoted(pidFile)})) {
            if ([DateTime]::UtcNow -gt $deadline) { throw 'late fixture timeout' }
            Start-Sleep -Milliseconds 10
          }
          [ExecutionJob]::Kill($job);`,
      );
      const { stdout } = await promisify(execFile)(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 25000 },
      );
      expect(stdout.trim()).toBe('TREE_CLOSED');
      const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
      await exited;
      expect(() => process.kill(grandchild, 0)).toThrow();
    } finally {
      if (root.exitCode === null && root.signalCode === null) root.kill();
      await exited;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  40000,
);
