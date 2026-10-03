import type { ChildProcess } from 'node:child_process';
import { execFileSync, fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openWorkStore } from '../src/workstore/SqliteWorkStore.js';
import type { WorkStore } from '../src/workstore/WorkStore.js';

/** Each RPC is handled independently so blocked OS calls do not hide races. */
class Peer {
  readonly child: ChildProcess;
  readonly events: string[] = [];
  private next = 0;
  private readonly replies = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly ready: Promise<void>;
  readonly exited: Promise<void>;
  constructor(bundle: string, root: string) {
    this.child = fork(bundle, [root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
    let stderr = '';
    this.child.stderr!.on('data', (chunk) => {
      stderr += String(chunk);
    });
    this.exited = new Promise((resolve) => this.child.once('exit', () => resolve()));
    this.ready = new Promise<void>((resolve, reject) => {
      this.child.once('error', reject);
      this.child.once('exit', () => {
        reject(new Error(`Peer exited before ready: ${stderr}`));
        for (const reply of this.replies.values())
          reply.reject(new Error(`Peer exited: ${stderr}`));
        this.replies.clear();
      });
      this.child.on('message', (message) => {
        const msg = message as { id?: number; event?: string; value?: unknown; error?: string };
        if (msg.event === 'ready') resolve();
        if (msg.event) this.events.push(msg.event);
        if (msg.id !== undefined) {
          const reply = this.replies.get(msg.id)!;
          this.replies.delete(msg.id);
          if (msg.error) reply.reject(new Error(msg.error));
          else reply.resolve(msg.value);
        }
      });
    });
  }
  call(op: string, args: unknown[] = []): Promise<unknown> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.replies.set(id, { resolve, reject });
      this.child.send({ id, op, args });
    });
  }
  async stop(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    await this.exited;
  }
}

describe('lease fencing across real Node processes', () => {
  let root: string;
  let store: WorkStore;
  const peers: Peer[] = [];
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-lease-processes-'));
    execFileSync('git', ['init', root], { stdio: 'pipe', windowsHide: true });
    store = await openWorkStore({ repositoryPath: root, projectId: 'shared' });
    store.createTask({ key: 'task', type: 'dev', status: 'QUEUED' });
    const bundle = path.join(root, 'peer.cjs');
    await build({
      stdin: {
        resolveDir: path.resolve('..'),
        contents: `
        import {openWorkStore} from './server/src/workstore/SqliteWorkStore.ts';
        import {DatabaseSync} from 'node:sqlite';
        import {configure} from 'controlled-process-recovery';
        const RealDate=Date; let now=Date.parse('2026-10-03T10:00:00Z');
        global.Date=class extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now(){return now;} };
        openWorkStore({repositoryPath:process.argv[2],projectId:'shared'}).then(store=>{
          process.on('message', async ({id,op,args})=>{
            try {
              let value;
              if(op==='time') now=args[0];
              else if(op==='control') configure(args[0]);
              else if(op==='recoverStale') {
                // An old candidate list, delivered after a renewal of the SAME generation.
                const prepare=DatabaseSync.prototype.prepare;
                DatabaseSync.prototype.prepare=function(sql) {
                  if(sql.startsWith('SELECT key FROM tasks')) return {all:()=>[{key:'task'}]};
                  return prepare.call(this,sql);
                };
                try {value=await store.recoverExpiredLeases();} finally {DatabaseSync.prototype.prepare=prepare;}
              }
              else if(op==='execution') value=await store.createExecution({
                key:args[0], task_key:'task', agent_template_version:'developer@v1', executor:'fixture',
                model_id:'fixture', session_id:null, pid:12345, started_at:new Date().toISOString(),
                system_prompt_hash:'hash', project_brain_sha:'sha', task_version:store.getTask('task').version,
                tool_policy_version:'v1'
              });
              else value=await store[op](...args);
              process.send({id,value});
            } catch(error){process.send({id,error:error.message});}
          });
          process.send({event:'ready'});
        }).catch(error=>{console.error(error);process.exit(1)});
      `,
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundle,
      plugins: [
        {
          name: 'controlled-os-boundary',
          setup(build) {
            build.onResolve(
              { filter: /(?:processRecovery\.[jt]s|controlled-process-recovery)$/ },
              () => ({ path: 'controlled', namespace: 'test-os' }),
            );
            build.onLoad({ filter: /.*/, namespace: 'test-os' }, () => ({
              contents: `
          let holdKill=false, holdIdentity=false; const kills=[], identities=[];
          export function configure(mode) {
            if(mode==='holdKill') holdKill=true;
            if(mode==='holdIdentity') holdIdentity=true;
            if(mode==='finishKill') {holdKill=false; kills.splice(0).forEach(r=>r());}
            if(mode==='finishIdentity') {holdIdentity=false; identities.splice(0).forEach(r=>r('123456'));}
          }
          export async function processStartIdentity() {
            if(holdIdentity) {process.send({event:'identity'}); return new Promise(r=>identities.push(r));}
            return '123456';
          }
          export async function terminateExecutionTree() {
            process.send({event:'kill'});
            if(holdKill) await new Promise(r=>kills.push(r));
          }
        `,
            }));
          },
        },
      ],
    });
    peers.push(new Peer(bundle, root), new Peer(bundle, root));
    await Promise.all(peers.map((p) => p.ready));
  });
  afterEach(async () => {
    await Promise.all(peers.splice(0).map((p) => p.stop()));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const time = Date.parse('2026-10-03T10:00:00Z');
  it('only one actual process wins a simultaneous claim', async () => {
    const results = await Promise.allSettled(
      peers.map((p, i) => p.call('claim', ['task', `worker-${i}`, 1000])),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(store.listDomainEvents('task').filter((e) => e.to_status === 'LEASED')).toHaveLength(1);
  });
  it('a stale candidate cannot kill a renewed lease of the same generation', async () => {
    const [a, b] = peers;
    await b.call('claim', ['task', 'worker', 1000]);
    await b.call('execution', ['original']);
    await b.call('time', [time + 900]);
    await b.call('heartbeat', ['task', 'worker', 1000]);
    await a.call('time', [time + 1000]);
    expect(await a.call('recoverStale')).toEqual([]);
    expect(a.events).not.toContain('kill');
    expect(store.getTask('task')).toMatchObject({ version: 2, lease_owner: 'worker' });
  });
  it('reserves before kill, excludes renewal/registration/transition and finalizes once against its token', async () => {
    const [a, b] = peers;
    await b.call('claim', ['task', 'worker', 1000]);
    await b.call('execution', ['original']);
    await a.call('time', [time + 1000]);
    await a.call('control', ['holdKill']);
    const sweep = a.call('recoverExpiredLeases');
    await vi.waitFor(() => expect(a.events).toContain('kill'));
    const token = store.listLeaseRecoveries()[0].token;
    // Even a worker with a backward clock must lose to the persistent token.
    await b.call('time', [time + 900]);
    await expect(b.call('heartbeat', ['task', 'worker', 1000])).rejects.toThrow(
      'recovery reserved',
    );
    await expect(b.call('execution', ['late'])).rejects.toThrow('recovery reserved');
    await expect(b.call('transition', ['task', 2, 'RUNNING', 'late', 'worker'])).rejects.toThrow(
      'recovery reserved',
    );
    expect(await b.call('recoverExpiredLeases')).toEqual([]);
    expect(store.listLeaseRecoveries()[0].token).toBe(token);
    await a.call('control', ['finishKill']);
    expect(await sweep).toMatchObject([{ status: 'FAILED_RETRYABLE', attempt: 1 }]);
    expect(store.listLeaseRecoveries()).toEqual([]);
    expect(store.listExecutions()).toHaveLength(1);
    expect(store.getExecution('original')?.tree_closed_at).toBeTruthy();
    expect(await b.call('claim', ['task', 'next'])).toMatchObject({ lease_owner: 'next' });
    expect(store.listDomainEvents('task').filter((e) => e.actor === 'lease-sweeper')).toHaveLength(
      1,
    );
  });
  it('fences a registration whose async identity query overlaps recovery in another process', async () => {
    const [a, b] = peers;
    await b.call('claim', ['task', 'worker', 1000]);
    await b.call('control', ['holdIdentity']);
    const registration = b.call('execution', ['late']);
    await vi.waitFor(() => expect(b.events).toContain('identity'));
    await a.call('time', [time + 1000]);
    await a.call('recoverExpiredLeases');
    await b.call('control', ['finishIdentity']);
    await expect(registration).rejects.toThrow('Task changed');
    expect(store.listExecutions()).toEqual([]);
  });
  it('never steals the token of a recovery process that died while holding OS handles', async () => {
    const [a, b] = peers;
    await b.call('claim', ['task', 'worker', 1000]);
    await b.call('execution', ['original']);
    await a.call('time', [time + 1000]);
    await a.call('control', ['holdKill']);
    const sweep = a.call('recoverExpiredLeases').catch(() => undefined);
    await vi.waitFor(() => expect(a.events).toContain('kill'));
    const token = store.listLeaseRecoveries()[0].token;
    await a.stop();
    await sweep;
    await b.call('time', [time + 100000]);
    expect(await b.call('recoverExpiredLeases')).toEqual([]);
    await expect(b.call('claim', ['task', 'next'])).rejects.toThrow('reconcile if abandoned');
    expect(store.listLeaseRecoveries()[0].token).toBe(token);
    store.createTask({ key: 'independent', type: 'dev', status: 'QUEUED' });
    expect(await b.call('claim', ['independent', 'next'])).toMatchObject({ lease_owner: 'next' });
  });
});
