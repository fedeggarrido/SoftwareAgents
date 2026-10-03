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
      fs.writeFileSync(path.join(root, 'partial.txt'), 'committed\n');
      const git = (args: string[]) =>
        execFileSync('git', args, {
          cwd: root,
          stdio: 'pipe',
          windowsHide: true,
          encoding: 'utf8',
        });
      git(['add', 'partial.txt']);
      git([
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=NUL',
        'commit',
        '-m',
        'fixture',
      ]);
      const worktree = path.join(root, 'worktree');
      git(['worktree', 'add', '-b', 'fixture-task', worktree]);
      fs.writeFileSync(path.join(worktree, 'partial.txt'), 'partial implementation\n');
      fs.writeFileSync(path.join(worktree, 'untracked.txt'), 'unfinished\n');
      // An actual junction inside the worktree must remain intact throughout recovery.
      const dependencies = path.join(root, 'fixture-dependencies');
      fs.mkdirSync(dependencies);
      fs.writeFileSync(path.join(dependencies, 'keep.txt'), 'dependencies');
      const junction = path.join(worktree, 'node_modules');
      fs.symlinkSync(dependencies, junction, 'junction');
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
      store = await openWorkStore({ repositoryPath: worktree, projectId: 'orphan-test' });
      store.createTask({
        key: 'task',
        type: 'implementation',
        status: 'QUEUED',
        worktree_ref: worktree,
        branch: 'fixture-task',
      });
      const lease = await store.claim('task', 'worker-first', 60_000);
      await store.createExecution({
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
      expect(await processStartIdentity(cliPid)).not.toBeNull();
      expect(await processStartIdentity(descendantPid)).not.toBeNull();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 60_001);
      const claimed = await store.claim('task', 'worker-next');
      expect(claimed).toMatchObject({
        status: 'LEASED',
        lease_owner: 'worker-next',
        attempt: 1,
        worktree_ref: worktree,
        branch: 'fixture-task',
      });
      expect(await processStartIdentity(cliPid)).toBeNull();
      expect(await processStartIdentity(descendantPid)).toBeNull();
      expect(fs.existsSync(cliFile)).toBe(true); // Worktree contents are preserved.
      expect(fs.readFileSync(path.join(worktree, 'partial.txt'), 'utf8')).toBe(
        'partial implementation\n',
      );
      expect(fs.readFileSync(path.join(worktree, 'untracked.txt'), 'utf8')).toBe('unfinished\n');
      expect(fs.realpathSync(junction)).toBe(fs.realpathSync(dependencies));
      expect(git(['-C', worktree, 'branch', '--show-current']).trim()).toBe('fixture-task');
      // Remove only our fixture junction, never its target or any repo dependency junction.
      fs.unlinkSync(junction);
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
      const junction = path.join(root, 'worktree', 'node_modules');
      if (fs.existsSync(junction)) fs.unlinkSync(junction);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);

it.skipIf(process.platform !== 'win32')(
  'a missing CLI root with a surviving writer blocks automatic reuse and leaves the error visible',
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-missing-root-'));
    let store: WorkStore | undefined;
    let cli: ReturnType<typeof fork> | undefined;
    let childPid: number | undefined;
    try {
      execFileSync('git', ['init', root], { stdio: 'pipe', windowsHide: true });
      const cliFile = path.join(root, 'cli.cjs');
      const partial = path.join(root, 'partial.txt');
      const writerFile = path.join(root, 'writer.cjs');
      fs.writeFileSync(
        writerFile,
        `setInterval(()=>require('node:fs').appendFileSync(process.argv[2],'partial\\n'),20);`,
      );
      fs.writeFileSync(
        cliFile,
        `const {spawn}=require('node:child_process');
        const child=spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:'ignore',windowsHide:true,detached:true});child.unref();
        process.send({pid:child.pid});process.once('message',()=>process.exit(0));`,
      );
      cli = fork(cliFile, [writerFile, partial], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: [],
      });
      childPid = await new Promise<number>((resolve, reject) => {
        cli!.once('message', (msg) => resolve((msg as { pid: number }).pid));
        cli!.once('error', reject);
        cli!.once('exit', () => reject(new Error('CLI exited before reporting its descendant')));
      });
      store = await openWorkStore({ repositoryPath: root, projectId: 'missing-root' });
      store.createTask({ key: 'task', type: 'dev', status: 'QUEUED', worktree_ref: root });
      const lease = await store.claim('task', 'original', 60000);
      await store.createExecution({
        key: 'run',
        task_key: 'task',
        agent_template_version: 'dev@v1',
        executor: 'fixture',
        model_id: 'fixture',
        session_id: null,
        pid: cli.pid!,
        started_at: new Date().toISOString(),
        system_prompt_hash: 'hash',
        project_brain_sha: 'sha',
        task_version: lease.version,
        tool_policy_version: 'v1',
      });
      const exit = new Promise<void>((resolve) => cli!.once('exit', () => resolve()));
      cli.send('exit-root');
      await exit;
      expect(await processStartIdentity(cli.pid!)).toBeNull();
      await vi.waitFor(() => expect(fs.existsSync(partial)).toBe(true));
      const before = fs.statSync(partial).size;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 60001);
      await expect(store.claim('task', 'next')).rejects.toThrow('root disappeared');
      expect(store.listLeaseRecoveries()).toMatchObject([
        { task_key: 'task', error: expect.stringContaining('tree closure unproven') },
      ]);
      expect(store.getTask('task')).toMatchObject({ lease_owner: 'original', attempt: 0 });
      expect(store.getExecution('run')?.tree_closed_at).toBeNull();
      expect(await processStartIdentity(childPid)).not.toBeNull();
      await vi.waitFor(() => expect(fs.statSync(partial).size).toBeGreaterThan(before));
    } finally {
      vi.useRealTimers();
      store?.close();
      for (const pid of [childPid, cli?.pid])
        if (pid) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* fixture already exited */
          }
        }
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
