import { type ChildProcess, execFileSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';

import { getHookScriptPath, makeHookEntry } from '../providers/hook/claude/claudeHookInstaller.js';
import { CLAUDE_HOOK_EVENTS } from '../providers/hook/claude/constants.js';
import { parseClaudeRateLimit } from '../quotaReader.js';
import type { ExecutionEvent, ExecutionHandle, ExecutionRequest, Executor } from './executor.js';

export interface ClaudeCliExecutorOptions {
  /** Trusted operator executable, not project content. Native executable on Windows. */
  binary: string;
  /** Operator argv prefix, e.g. node + fake-cli.cjs + claude in tests. */
  binaryArgs?: readonly string[];
  /** Private runtime storage outside the worktree, controlled by the Operator. */
  runtimeDirectory: string;
  /** Installed Pixel Agents hook command; omit to use the installer's default. */
  hookCommand?: string;
}

/** Configuration isolation is not an OS sandbox. No arbitrary compiled flags until SA-020. */
export class ClaudeCliExecutor implements Executor {
  readonly id = 'claude' as const;
  constructor(private readonly options: ClaudeCliExecutorOptions) {}

  start(req: ExecutionRequest): ExecutionHandle {
    if (req.flags.length || req.role.toLowerCase() !== 'developer') {
      throw new Error('Only the fixed Developer profile is supported until SA-020');
    }
    if (!Number.isFinite(req.timeoutMin) || req.timeoutMin <= 0) throw new Error('Invalid timeout');
    const sessionId = randomUUID();
    let child: ChildProcess | undefined;
    let cancelled = false;
    let cancellationFailure: Error | undefined;
    let done = false;
    const cancel = () => {
      if (done || cancelled) return;
      cancelled = true;
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32') {
        try {
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        } catch (error) {
          cancellationFailure = error as Error;
          throw error;
        }
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    };
    const options = this.options;
    return {
      sessionId,
      cancel,
      events: (async function* (): AsyncGenerator<ExecutionEvent> {
        let directory: string | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (cancelled) {
            yield { type: 'finished', exitCode: 130, resultSummary: 'Cancelled' };
            return;
          }
          fs.mkdirSync(options.runtimeDirectory, { recursive: true, mode: 0o700 });
          const relative = path.relative(
            fs.realpathSync(req.worktreePath),
            fs.realpathSync(options.runtimeDirectory),
          );
          if (
            relative === '' ||
            (!path.isAbsolute(relative) &&
              relative !== '..' &&
              !relative.startsWith(`..${path.sep}`))
          ) {
            throw new Error('Runtime settings must be outside the worktree');
          }
          directory = fs.mkdtempSync(path.join(options.runtimeDirectory, 'claude-'));
          const settings = path.join(directory, 'settings.json');
          const mcp = path.join(directory, 'mcp.json');
          const hooksAvailable = fs.existsSync(getHookScriptPath());
          fs.writeFileSync(
            settings,
            JSON.stringify({
              hooks: hooksAvailable
                ? Object.fromEntries(
                    CLAUDE_HOOK_EVENTS.map((event) => [
                      event,
                      [makeHookEntry(options.hookCommand)],
                    ]),
                  )
                : undefined,
              permissions: { defaultMode: 'dontAsk' },
            }),
            { mode: 0o600 },
          );
          fs.writeFileSync(mcp, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
          const tools = 'Read,Glob,Grep,Edit,Write';
          const args = [
            ...(options.binaryArgs ?? []),
            '-p',
            '--output-format',
            'stream-json',
            '--verbose',
            '--session-id',
            sessionId,
            '--strict-mcp-config',
            '--mcp-config',
            mcp,
            '--settings',
            settings,
            '--setting-sources',
            '',
            '--allowedTools',
            tools,
            '--tools',
            tools,
            '--permission-mode',
            'dontAsk',
            '--no-chrome',
            '--disable-slash-commands',
            ...(req.model ? ['--model', req.model] : []),
          ];
          child = spawn(options.binary, args, {
            cwd: req.worktreePath,
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          const processChild = child;
          let failure: Error | undefined;
          const completion = new Promise<number>((resolve) => {
            processChild.on('error', (error) => {
              failure = error;
            });
            processChild.on('close', (code) => resolve(code ?? 1));
          });
          processChild.stdin!.on('error', () => {
            /* premature process exit */
          });
          processChild.stdin!.end(req.prompt);
          timer = setTimeout(() => {
            try {
              cancel();
            } catch {
              /* surfaced after the process closes */
            }
          }, req.timeoutMin * 60_000);
          const queue: ExecutionEvent[] = [];
          let wake: (() => void) | undefined;
          const push = (event: ExecutionEvent) => {
            queue.push(event);
            wake?.();
          };
          const readers = (['stdout', 'stderr'] as const).map(async (stream) => {
            for await (const line of createInterface({ input: processChild[stream]! })) {
              if (stream === 'stderr') {
                push({ type: 'output', text: line, stream });
                continue;
              }
              try {
                const record = JSON.parse(line);
                if (!record?.type) {
                  push({ type: 'output', text: line, stream });
                  continue;
                }
                if (record.type === 'system' && record.subtype === 'init') {
                  push({
                    type: 'output',
                    stream,
                    text: JSON.stringify({
                      type: 'init',
                      sessionId: record.session_id,
                      tools: record.tools,
                      mcpServers: record.mcp_servers,
                      authSource: record.apiKeySource,
                    }),
                  });
                }
                if (record.type === 'assistant') {
                  for (const content of record.message?.content ?? []) {
                    if (content.type === 'tool_use')
                      push({
                        type: 'toolUse',
                        toolId: content.id,
                        toolName: content.name,
                        input: content.input,
                      });
                    if (content.type === 'text')
                      push({ type: 'output', text: content.text, stream });
                  }
                }
                // Result usage is cumulative; assistant usage must not be counted twice.
                if (record.type === 'result') {
                  if (record.usage)
                    push({
                      type: 'usage',
                      inputTokens: record.usage.input_tokens ?? 0,
                      outputTokens: record.usage.output_tokens ?? 0,
                    });
                  summary = record.result ?? record.errors?.join('\n') ?? '';
                  resultError = record.is_error === true;
                  if (summary) push({ type: 'output', text: summary, stream });
                }
                if (record.type === 'rate_limit_event') {
                  const now = Date.now() / 1000;
                  const quota = parseClaudeRateLimit(record.rate_limit_info ?? {}, now, now);
                  push({
                    type: 'rateLimit',
                    retryAfterSec:
                      quota.status === 'rejected' && quota.resetsAt !== null
                        ? Math.max(0, Math.ceil(quota.resetsAt - now))
                        : 0,
                    message: quota.status,
                  });
                }
              } catch {
                push({ type: 'output', text: line, stream });
              }
            }
          });
          let summary = '';
          let resultError = false;
          let closed = false;
          let exitCode = 1;
          void Promise.allSettled([completion, ...readers]).then((results) => {
            const processResult = results[0];
            exitCode = processResult.status === 'fulfilled' ? (processResult.value as number) : 1;
            const streamFailure = results.find((result) => result.status === 'rejected');
            if (streamFailure?.status === 'rejected') {
              failure = streamFailure.reason as Error;
              exitCode = 1;
            }
            closed = true;
            wake?.();
          });
          yield {
            type: 'started',
            sessionId,
            pid: child.pid ?? 0,
            startedAt: new Date().toISOString(),
          };
          if (!hooksAvailable) {
            yield {
              type: 'output',
              stream: 'stdout',
              text: '[Pixel Agents] Hooks omitted: hook script is not installed. Installation requires hooks consent.',
            };
          }
          while (!closed || queue.length) {
            if (queue.length) yield queue.shift()!;
            else
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
          }
          done = true;
          yield {
            type: 'finished',
            exitCode: cancellationFailure
              ? 1
              : cancelled
                ? 130
                : resultError || failure
                  ? 1
                  : exitCode,
            resultSummary:
              cancellationFailure?.message ??
              (cancelled ? 'Cancelled' : (failure?.message ?? summary)),
          };
        } finally {
          if (timer) clearTimeout(timer);
          if (!done) cancel();
          done = true;
          if (directory) fs.rmSync(directory, { recursive: true, force: true });
        }
      })(),
    };
  }
}
