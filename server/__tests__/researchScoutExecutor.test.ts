import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { afterEach, expect, it, vi } from 'vitest';

import { WEB_SCOUT_SPEC } from '../../core/src/agentSpec.js';
import { ClaudeCliExecutor } from '../src/executors/claudeCliExecutor.js';
import { spawnRegisteredProcess } from '../src/executors/registeredProcess.js';
import { scoutSchema } from '../src/webScout.js';

vi.mock('../src/executors/registeredProcess.js', () => ({
  spawnRegisteredProcess: vi.fn(),
  cancelRegisteredProcess: () => false,
}));
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(['valid', 'Read', 'WebFetch', 'mcp__secret__read', 'Agent', 'prose'])(
  'enforces scout launch and output boundary with simulated CLI: %s',
  async (mode) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-executor-'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    vi.stubEnv('ProgramFiles', path.join(root, 'program-files'));
    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(worktree);
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    let settings: Record<string, unknown> = {},
      cwd = '',
      args: string[] = [];
    vi.mocked(spawnRegisteredProcess).mockImplementation((_binary, argv, directory) => {
      args = argv;
      cwd = directory;
      settings = JSON.parse(fs.readFileSync(argv[argv.indexOf('--settings') + 1], 'utf8'));
      child.stdin.on('finish', () =>
        setImmediate(() => {
          const tools = mode === 'valid' || mode === 'prose' ? ['WebSearch'] : ['WebSearch', mode];
          const emit = (record: unknown) => child.stdout.write(JSON.stringify(record) + '\n');
          emit({ type: 'system', subtype: 'init', tools });
          emit({
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', id: 'call', name: tools.at(-1), input: { query: 'public' } },
              ],
            },
          });
          emit({
            type: 'result',
            result: mode === 'prose' ? 'prose {"candidates":[]}' : '{"candidates":[]}',
            usage: { input_tokens: 2, output_tokens: 2 },
          });
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 0);
        }),
      );
      return child as unknown as ChildProcess;
    });
    try {
      const executor = new ClaudeCliExecutor({
        binary: 'fixture-only',
        runtimeDirectory: path.join(root, 'runtime'),
        containmentHookScript: __filename,
      });
      const events = [];
      for await (const event of executor.start({
        executionId: 'fixture',
        projectId: 'fixture',
        taskKey: 'scout',
        role: 'web-scout',
        agentSpec: WEB_SCOUT_SPEC,
        flags: [],
        prompt: '',
        worktreePath: worktree,
        timeoutMin: 1,
        taskData: { task: { question: 'public question' }, outputSchema: scoutSchema(2) },
      }).events)
        events.push(event);
      expect(cwd).not.toBe(worktree);
      expect(args).not.toContain('--bare');
      expect(args).toContain('--system-prompt');
      expect(args).toContain('--disable-slash-commands');
      expect(args[args.indexOf('--tools') + 1]).toBe('WebSearch');
      expect(settings).toMatchObject({ claudeMdExcludes: ['**'], autoMemoryEnabled: false });
      expect(events.at(-1)).toMatchObject({ type: 'finished', exitCode: mode === 'valid' ? 0 : 1 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
