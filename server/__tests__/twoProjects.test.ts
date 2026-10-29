import { type ChildProcess, execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildSync } from 'esbuild';
import { expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { stringify } from 'yaml';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';

it('isolates two standalone Managed Projects with Watch All and foreign hooks', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'two-projects-'));
  const children: ChildProcess[] = [];
  const sockets: WebSocket[] = [];
  const roots = ['project-a', 'project-b'].map((id) => path.join(temp, id));
  const homes = roots.map((_, index) => path.join(temp, `home-${index}`));
  try {
    const bundle = path.join(temp, 'server.cjs');
    buildSync({
      entryPoints: [path.resolve('__tests__/fixtures/twoProjectsServer.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      banner: { js: "require('os').homedir = () => process.env.HOME;" },
    });
    for (const [index, root] of roots.entries()) {
      fs.mkdirSync(path.join(root, '.softwareagents'), { recursive: true });
      fs.mkdirSync(homes[index], { recursive: true });
      fs.writeFileSync(
        path.join(root, '.softwareagents/board.json'),
        JSON.stringify({
          items: [
            {
              id: `task-${path.basename(root)}`,
              title: `title-${path.basename(root)}`,
              phase: 'READY',
            },
          ],
        }),
      );
      execFileSync('git', ['init', root], {
        windowsHide: true,
        stdio: 'pipe',
        env: { ...process.env, HOME: homes[index], USERPROFILE: homes[index] },
      });
      fs.writeFileSync(
        path.join(root, '.softwareagents/project.yaml'),
        stringify({
          apiVersion: 'softwareagents.io/v1alpha1',
          kind: 'Project',
          id: path.basename(root),
          name: `title-${path.basename(root)}`,
          repo: { remote: 'https://example.com/repo.git', defaultBranch: 'main' },
          brain: { path: '.softwareagents/brain' },
          legacy: { boardFile: '.softwareagents/board.json' },
          clickup: { workspaceId: '123', folderId: '456', listIds: ['789'] },
        }),
      );
    }
    // Use canonical cwd metadata even on hosts whose temporary directory is a symlink.
    const canonical = roots.map((root) => fs.realpathSync.native(root));
    for (const home of homes) {
      fs.mkdirSync(path.join(home, '.pixel-agents'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.pixel-agents/config.json'),
        JSON.stringify({ standalone: { watchAllSessions: true }, hooksEnabled: { claude: false } }),
      );
      for (const [index, root] of canonical.entries()) {
        const id = path.basename(roots[index]);
        const dir = path.join(home, '.claude/projects', normalizeProjectPath(root));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, `claude-${id}.jsonl`),
          JSON.stringify({
            type: 'user',
            cwd: root,
            sessionId: `claude-${id}`,
            message: { role: 'user', content: `title-${id}` },
          }) + '\n',
        );
        const now = new Date();
        const day = path.join(
          home,
          '.codex/sessions',
          String(now.getFullYear()),
          String(now.getMonth() + 1).padStart(2, '0'),
          String(now.getDate()).padStart(2, '0'),
        );
        fs.mkdirSync(day, { recursive: true });
        fs.writeFileSync(
          path.join(day, `rollout-${id}.jsonl`),
          JSON.stringify({ type: 'session_meta', payload: { id: `codex-${id}`, cwd: root } }) +
            '\n',
        );
      }
    }
    const servers = [];
    for (const [index, root] of roots.entries()) {
      const child = fork(bundle, [], {
        cwd: root,
        env: {
          ...process.env,
          HOME: homes[index],
          USERPROFILE: homes[index],
          TEST_PROJECT: path.basename(root),
          NODE_PATH: path.resolve('../node_modules'),
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      children.push(child);
      let output = '';
      child.stdout!.on('data', (data: Buffer) => {
        output += data.toString();
      });
      child.stderr!.on('data', (data: Buffer) => {
        output += data.toString();
      });
      const config = await new Promise<{ port: number; token: string }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Server startup timeout: ${output}`)),
          15000,
        );
        child.once('message', (message) => {
          clearTimeout(timer);
          resolve(message as { port: number; token: string });
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Server exited ${code}: ${output}`));
        });
        child.once('error', reject);
      });
      const messages: Record<string, any>[] = [];
      const socket = new WebSocket(`ws://127.0.0.1:${config.port}/ws?token=${config.token}`);
      sockets.push(socket);
      socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
      await once(socket, 'open');
      socket.send(JSON.stringify({ type: 'webviewReady' }));
      child.send('scan');
      await once(child, 'message');
      const transcript = path.join(
        homes[index],
        '.claude/projects',
        normalizeProjectPath(canonical[index]),
        `claude-${path.basename(root)}.jsonl`,
      );
      fs.appendFileSync(
        transcript,
        JSON.stringify({
          type: 'user',
          cwd: canonical[index],
          message: { role: 'user', content: 'continued' },
        }) + '\n',
      );
      const resumed = new Date(Date.now() + 2000);
      fs.utimesSync(transcript, resumed, resumed);
      servers.push({ ...config, messages, socket, output: () => output });
    }
    for (const [index, server] of servers.entries()) {
      const id = path.basename(roots[index]);
      const other = path.basename(roots[1 - index]);
      const post = async (cwd: string, session: string) => {
        const response = await fetch(`http://127.0.0.1:${server.port}/api/hooks/claude`, {
          method: 'POST',
          headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            hook_event_name: 'SessionStart',
            session_id: session,
            cwd,
            source: 'startup',
          }),
        });
        expect(response.ok).toBe(true);
      };
      await post(canonical[1 - index], `foreign-${other}`);
      await post(canonical[index], `claude-${id}`);
      await vi.waitFor(
        () => {
          expect(
            server.messages.filter((msg) => msg.type === 'agentCreated'),
            server.output(),
          ).toHaveLength(2);
        },
        { timeout: 10000 },
      );
      // Reconnect handshake exercises existingAgents after adoption.
      server.socket.send(JSON.stringify({ type: 'webviewReady' }));
      for (const type of ['requestFeatures', 'requestAuditLog'])
        server.socket.send(JSON.stringify({ type, projectId: id, requestId: type }));
      await vi.waitFor(() => {
        expect(server.messages.some((msg) => msg.type === 'featuresSnapshot')).toBe(true);
        expect(server.messages.some((msg) => msg.type === 'auditLog')).toBe(true);
        expect(
          server.messages.filter((msg) => msg.type === 'existingAgents').at(-1)?.agents,
        ).toHaveLength(2);
      });
      for (const msg of server.messages.filter((msg) =>
        ['agentCreated', 'boardState', 'workSnapshot', 'featuresSnapshot', 'auditLog'].includes(
          msg.type,
        ),
      ))
        expect(msg.projectId).toBe(id);
      const existing = server.messages.filter((msg) => msg.type === 'existingAgents').at(-1)!;
      for (const meta of Object.values(existing.agentMeta))
        expect(meta).toMatchObject({ projectId: id });
      expect(server.messages.find((msg) => msg.type === 'boardState')?.items).toEqual([
        expect.objectContaining({ id: `task-${id}`, title: `title-${id}` }),
      ]);
      const work = server.messages.find((msg) => msg.type === 'workSnapshot')!;
      expect(JSON.stringify(work)).toContain(`task-${id}`);
      expect(JSON.stringify(work)).toContain(`decision-${id}`);
      expect(
        JSON.stringify(server.messages.find((msg) => msg.type === 'featuresSnapshot')),
      ).toContain(index === 0 ? 'FEAT-001' : 'FEAT-002');
      expect(JSON.stringify(server.messages)).not.toContain(index === 0 ? 'FEAT-002' : 'FEAT-001');
      expect(JSON.stringify(server.messages.find((msg) => msg.type === 'auditLog'))).toContain(
        `action-${id}`,
      );
      expect(JSON.stringify(server.messages)).not.toContain(other);
      expect(JSON.stringify(server.messages)).not.toContain(
        JSON.stringify(canonical[1 - index]).slice(1, -1),
      );
    }
  } finally {
    for (const socket of sockets) socket.terminate();
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null) return;
        const exited = once(child, 'exit');
        const timer = setTimeout(() => child.kill(), 5000);
        if (child.connected) child.send('stop');
        else child.kill();
        await exited;
        clearTimeout(timer);
      }),
    );
    fs.rmSync(temp, { recursive: true, force: true });
  }
}, 45000);
