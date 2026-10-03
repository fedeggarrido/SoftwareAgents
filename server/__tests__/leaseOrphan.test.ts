import { execFileSync, fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { expect, it, vi } from 'vitest';

import { processStartIdentity } from '../src/workstore/processRecovery.js';
import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import type { WorkStore } from '../src/workstore/WorkStore.js';

it.skipIf(process.platform !== 'win32' || process.env['SA_SKIP_TASKKILL_TEST'] === '1')(
  'a dead worker leaves a live CLI; next claim kills the CLI tree before reassignment',
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-orphan-'));
    const pids: number[] = [];
    let store: WorkStore | undefined;
    try {
      execFileSync('git', ['init', root], { stdio: 'pipe', windowsHide: true });
      const workerFile = path.join(root, 'worker.cjs');
      const cliFile = path.join(root, 'cli.cjs');
      const descendantFile = path.join(root, 'descendant.pid');
      fs.writeFileSync(
        workerFile,
        `const {spawn}=require('node:child_process');
        const cli=spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:'ignore',windowsHide:true,detached:true}); cli.unref();
        process.send({pid:cli.pid}); setInterval(()=>{},1000);`,
      );
      fs.writeFileSync(
        cliFile,
        `const {spawn}=require('node:child_process');
        const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
        require('node:fs').writeFileSync(process.argv[2],String(child.pid)); setInterval(()=>{},1000);`,
      );
      const worker = fork(workerFile, [cliFile, descendantFile], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      pids.push(worker.pid!);
      const cliPid = await new Promise<number>((resolve, reject) => {
        worker.once('message', (msg) => resolve((msg as { pid: number }).pid));
        worker.once('error', reject);
        worker.once('exit', () => reject(new Error('Worker exited before reporting its CLI')));
      });
      pids.push(cliPid);
      await vi.waitFor(() => expect(fs.existsSync(descendantFile)).toBe(true));
      const descendantPid = Number(fs.readFileSync(descendantFile, 'utf8'));
      pids.push(descendantPid);
      store = await openWorkStore({ repositoryPath: root, projectId: 'orphan-test' });
      store.createTask({
        key: 'task',
        type: 'implementation',
        status: 'QUEUED',
        worktree_ref: root,
      });
      const lease = await store.claim('task', 'worker-first', 60_000);
      store.createExecution({
        key: 'execution',
        task_key: 'task',
        agent_template_version: 'developer@v1',
        executor: 'codex',
        model_id: 'model',
        session_id: null,
        pid: cliPid,
        started_at: new Date().toISOString(),
        system_prompt_hash: 'hash',
        project_brain_sha: 'sha',
        task_version: lease.version,
        tool_policy_version: 'v1',
      });
      const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
      process.kill(worker.pid!, 'SIGKILL');
      await exited;
      expect(processStartIdentity(cliPid)).not.toBeNull();
      expect(processStartIdentity(descendantPid)).not.toBeNull();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 60_001);
      const claimed = await store.claim('task', 'worker-next');
      expect(claimed).toMatchObject({
        status: 'LEASED',
        lease_owner: 'worker-next',
        attempt: 1,
        worktree_ref: root,
      });
      expect(processStartIdentity(cliPid)).toBeNull();
      expect(processStartIdentity(descendantPid)).toBeNull();
      expect(fs.existsSync(cliFile)).toBe(true); // Worktree contents are preserved.
    } finally {
      vi.useRealTimers();
      store?.close();
      // Only fixture PIDs; no host-wide process scans or termination.
      for (const pid of pids.reverse()) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* fixture already terminated */
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
