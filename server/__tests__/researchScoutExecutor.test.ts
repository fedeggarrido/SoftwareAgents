import { type ChildProcess, spawn, type SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { afterEach, expect, it, vi } from 'vitest';

import { RESEARCHER_SPEC, WEB_SCOUT_SPEC } from '../../core/src/agentSpec.js';
import { WEB_SCOUT_MAX_TURNS } from '../src/constants.js';
import { ClaudeCliExecutor } from '../src/executors/claudeCliExecutor.js';
import type { ExecutionEvent, ExecutionRequest } from '../src/executors/executor.js';
import { discoverUrls, scoutSchema } from '../src/webScout.js';

vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(['feature-research-review', 'research-run'])(
  'launches researcher %s with persistence disabled (simulated process)',
  async (kind) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'researcher-executor-'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(worktree);
    const sessionFile = path.join(root, 'session.jsonl');
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    let args: string[] = [];
    vi.mocked(spawn).mockImplementation((_binary, argv) => {
      args = argv as string[];
      child.stdin.on('finish', () =>
        setImmediate(() => {
          if (!args.includes('--no-session-persistence'))
            fs.writeFileSync(sessionFile, 'Synthetic retained session');
          child.stdout.write(
            JSON.stringify({
              type: 'result',
              result: '{}',
              usage: { input_tokens: 1, output_tokens: 1 },
            }) + '\n',
          );
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
      const events: ExecutionEvent[] = [];
      for await (const event of executor.start({
        executionId: 'fixture',
        projectId: 'fixture',
        taskKey: kind,
        role: 'researcher',
        agentSpec: RESEARCHER_SPEC,
        flags: [],
        prompt: '',
        worktreePath: worktree,
        timeoutMin: 1,
        taskData: { task: { kind } },
      }).events)
        events.push(event);
      expect(args.filter((arg) => arg === '--no-session-persistence')).toHaveLength(1);
      expect(args).toContain('--system-prompt');
      expect(args).not.toContain('--append-system-prompt');
      expect(fs.existsSync(sessionFile)).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: 'finished', exitCode: 0 });
    } finally {
      const target = path.resolve(root);
      if (!path.basename(target).startsWith('researcher-executor-'))
        throw new Error('Unsafe fixture cleanup');
      fs.rmSync(target, { recursive: true, force: true });
    }
  },
);

it.each(['valid', 'Read', 'WebFetch', 'mcp__secret__read', 'Agent', 'prose'])(
  'enforces scout launch and output boundary with simulated CLI: %s',
  async (mode) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-executor-'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    vi.stubEnv('ProgramFiles', path.join(root, 'program-files'));
    for (const key of [
      'CLICKUP_TOKEN',
      'GH_TOKEN',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_PROFILE',
      'PIXEL_AGENTS_OPERATOR_TOKEN',
      'NODE_OPTIONS',
      'UNRELATED_SECRET',
    ])
      vi.stubEnv(key, 'fixture-secret');
    vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-auth');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'fixture-auth-token');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'fixture-oauth');
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'unused-config'));
    vi.stubEnv('LANG', 'en_US.UTF-8');
    vi.stubEnv('LC_CTYPE', 'en_US.UTF-8');
    const configDir = path.join(root, 'claude-config');
    fs.mkdirSync(configDir);
    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(worktree);
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    let settings: Record<string, unknown> = {},
      cwd = '',
      args: string[] = [],
      environment: NodeJS.ProcessEnv = {};
    vi.mocked(spawn).mockImplementation((_binary, argv, options) => {
      args = argv as string[];
      const spawnOptions = options as SpawnOptions;
      cwd = spawnOptions.cwd as string;
      // A supervised launch carries the CLI environment separately from its own.
      environment = spawnOptions.env!.PIXEL_AGENTS_CLI_ENV
        ? JSON.parse(spawnOptions.env!.PIXEL_AGENTS_CLI_ENV)
        : spawnOptions.env!;
      settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
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
            total_cost_usd: 0.0123,
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
        configDir,
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
        researchBudget: { maxCostUsd: 0.8 },
        taskData: { task: { question: 'public question' }, outputSchema: scoutSchema(2) },
      }).events)
        events.push(event);
      expect(cwd).not.toBe(worktree);
      expect(args).not.toContain('--bare');
      expect(args).toContain('--system-prompt');
      expect(args).toContain('--disable-slash-commands');
      expect(args[args.indexOf('--max-turns') + 1]).toBe(String(WEB_SCOUT_MAX_TURNS));
      expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('0.8');
      expect(args[args.indexOf('--tools') + 1]).toBe('WebSearch');
      expect(environment).toMatchObject({
        HOME: root,
        USERPROFILE: root,
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_API_KEY: 'fixture-auth',
        ANTHROPIC_AUTH_TOKEN: 'fixture-auth-token',
        CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth',
        LANG: 'en_US.UTF-8',
        LC_CTYPE: 'en_US.UTF-8',
        SA_MANAGED_EXECUTION: 'worker',
      });
      for (const key of ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) {
        const parentKey = Object.keys(process.env).find((name) => name.toUpperCase() === key);
        if (parentKey) expect(environment[parentKey]).toBe(process.env[parentKey]);
      }
      expect(
        Object.keys(environment).filter((key) =>
          /^(CLICKUP_TOKEN|GH_TOKEN|AWS_.*|PIXEL_AGENTS_OPERATOR_TOKEN|NODE_OPTIONS|UNRELATED_SECRET)$/i.test(
            key,
          ),
        ),
      ).toEqual([]);
      expect(process.env.CLICKUP_TOKEN).toBe('fixture-secret');
      expect(settings).toMatchObject({ claudeMdExcludes: ['**'], autoMemoryEnabled: false });
      expect(events.at(-1)).toMatchObject({ type: 'finished', exitCode: mode === 'valid' ? 0 : 1 });
      expect(events.at(-1)).toHaveProperty('costUsd', 0.0123);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each([
  { mode: 'complete', cost: 0.125 },
  { mode: 'complete', cost: 0 },
  { mode: 'complete', cost: undefined },
  { mode: 'complete', cost: 'invalid' },
  { mode: 'complete', cost: '0.125' },
  { mode: 'complete', cost: -1 },
  { mode: 'cancel', cost: undefined },
])(
  'tracks multiple assistant turns with cache tokens and parses final CLI cost metadata: $mode, $cost',
  async ({ mode, cost }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-usage-'));
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
    const first = {
      type: 'assistant',
      message: {
        id: 'turn-1',
        content: [],
        usage: {
          input_tokens: 2,
          output_tokens: 3,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      },
    };
    const second = {
      type: 'assistant',
      message: {
        id: 'turn-2',
        content: [],
        usage: {
          input_tokens: 4,
          output_tokens: 5,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 6,
        },
      },
    };
    const records = [
      first,
      first, // Multiple content blocks can repeat the same message's usage.
      {
        ...first,
        message: { ...first.message, usage: { ...first.message.usage, output_tokens: 4 } },
      },
      second,
      {
        type: 'result',
        result: '{"candidates":[]}',
        total_cost_usd: cost,
        // Cumulative totals also reconcile usage absent from assistant messages.
        usage: {
          input_tokens: 8,
          output_tokens: 10,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 11,
        },
      },
    ];
    let closed = false;
    let finalWritten = false;
    const close = (code: number) => {
      if (closed) return;
      closed = true;
      child.stdout.end();
      child.stderr.end();
      child.emit('close', code);
    };
    vi.mocked(spawn).mockImplementation(() => {
      child.stdin.on('finish', () => {
        let index = 0;
        const next = () => {
          if (closed) return;
          const record = records[index++];
          if (!record) return close(0);
          finalWritten ||= record.type === 'result';
          child.stdout.write(JSON.stringify(record) + '\n');
          setImmediate(next);
        };
        setImmediate(next);
      });
      return child as unknown as ChildProcess;
    });
    try {
      const executor = new ClaudeCliExecutor({
        binary: 'fixture-only',
        runtimeDirectory: path.join(root, 'runtime'),
        containmentHookScript: __filename,
      });
      const request: ExecutionRequest = {
        executionId: 'usage',
        projectId: 'fixture',
        taskKey: 'scout',
        role: 'web-scout',
        agentSpec: WEB_SCOUT_SPEC,
        flags: [],
        prompt: '',
        worktreePath: worktree,
        timeoutMin: 1,
        taskData: { task: { question: 'public' }, outputSchema: scoutSchema(2) },
      };
      if (mode === 'complete') {
        const events: ExecutionEvent[] = [];
        for await (const event of executor.start(request).events) {
          if (event.type === 'usage' && !events.some((prior) => prior.type === 'usage'))
            expect(finalWritten).toBe(false);
          events.push(event);
        }
        expect(events.filter((event) => event.type === 'usage')).toEqual([
          { type: 'usage', inputTokens: 17, outputTokens: 3 },
          { type: 'usage', inputTokens: 0, outputTokens: 1 },
          { type: 'usage', inputTokens: 30, outputTokens: 5 },
          { type: 'usage', inputTokens: 2, outputTokens: 1 },
        ]);
        expect(events.at(-1)).toMatchObject({ type: 'finished', exitCode: 0 });
        if (typeof cost === 'number' && cost >= 0)
          expect(events.at(-1)).toHaveProperty('costUsd', cost);
        else expect(events.at(-1)).not.toHaveProperty('costUsd');
      } else {
        const cancel = vi.fn();
        await expect(
          discoverUrls(
            {
              id: 'claude',
              start: (req) => {
                const handle = executor.start(req);
                return {
                  ...handle,
                  cancel: () => {
                    cancel(finalWritten);
                    handle.cancel();
                    close(130);
                  },
                };
              },
            },
            request,
            'public',
            2,
            50, // Uncached tokens total only 15; cache pushes turn 2 over budget.
            new AbortController().signal,
          ),
        ).rejects.toThrow('Scout token budget exhausted');
        expect(cancel).toHaveBeenCalledWith(false);
        expect(finalWritten).toBe(false);
      }
    } finally {
      close(0);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
