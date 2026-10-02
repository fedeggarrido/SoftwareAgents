import { type ChildProcess, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';

import type { ProjectOperatorConfig } from '../../../core/src/project.js';
import { codexCompilerFlags, compileAgent, validateAgentOutput } from '../agentCompiler.js';
import { CODEX_WINDOWS_SANDBOX } from '../constants.js';
import { parseCodexRateLimits } from '../quotaReader.js';
import type { ExecutionEvent, ExecutionHandle, ExecutionRequest, Executor } from './executor.js';

/** Only trusted Operator config can select an executable. An invalid override fails closed. */
export function resolveCodexBinary(
  operator: Pick<ProjectOperatorConfig, 'binaryPaths'> = {},
  env = process.env,
  platform = process.platform,
): string {
  const executable = (file: string) => {
    try {
      return (
        fs.statSync(file).isFile() &&
        (platform === 'win32'
          ? file.toLowerCase().endsWith('.exe')
          : (fs.accessSync(file, fs.constants.X_OK), true))
      );
    } catch {
      return false;
    }
  };
  const configured = operator.binaryPaths?.codex;
  if (configured !== undefined) {
    if (!path.isAbsolute(configured) || !executable(configured))
      throw new Error(
        'Invalid Operator binaryPaths.codex: expected an existing absolute executable path',
      );
    return configured;
  }
  for (const directory of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    const file = path.resolve(
      directory.replace(/^"|"$/g, ''),
      platform === 'win32' ? 'codex.exe' : 'codex',
    );
    if (executable(file)) return file;
  }
  if (env.LOCALAPPDATA) {
    const root = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      const candidates = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(root, e.name, 'codex.exe'))
        .filter(executable);
      candidates.sort(
        (a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs || a.localeCompare(b),
      );
      if (candidates[0]) return candidates[0];
    } catch {
      /* no desktop installation */
    }
  }
  throw new Error(
    'Codex executable not found: configure projects.<id>.binaryPaths.codex, add Codex to PATH, or install the Codex desktop app',
  );
}

export interface CodexCliExecutorOptions {
  operator: Pick<ProjectOperatorConfig, 'binaryPaths'>;
  /** Private Operator storage outside the worktree. */
  runtimeDirectory: string;
  /** Trusted prefix for test harnesses; never supplied by repository content. */
  binaryArgs?: readonly string[];
}

export class CodexCliExecutor implements Executor {
  readonly id = 'codex' as const;
  constructor(private readonly options: CodexCliExecutorOptions) {}
  start(req: ExecutionRequest): ExecutionHandle {
    if (req.flags.length) throw new Error('Caller flags are forbidden');
    if (!req.agentSpec) throw new Error('Codex requires an AgentSpec');
    if (!Number.isFinite(req.timeoutMin) || req.timeoutMin <= 0) throw new Error('Invalid timeout');
    const compiled = compileAgent(
      req.agentSpec,
      req.role,
      req.taskData ?? { task: { key: req.taskKey, content: req.prompt } },
    );
    const binary = resolveCodexBinary(this.options.operator);
    const options = this.options;
    let child: ChildProcess | undefined;
    let cancelled = false,
      done = false;
    let cancelFailure: Error | undefined;
    const cancel = () => {
      if (done || cancelled) return;
      cancelled = true;
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform === 'win32')
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          cancelFailure = error as Error;
          throw error;
        }
      }
    };
    return {
      cancel,
      events: (async function* (): AsyncGenerator<ExecutionEvent> {
        let directory: string | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (cancelled) {
            done = true;
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
          )
            throw new Error('Runtime settings must be outside the worktree');
          directory = fs.mkdtempSync(path.join(options.runtimeDirectory, 'codex-'));
          const schemaFile = path.join(directory, 'output-schema.json');
          if (compiled.outputSchema)
            fs.writeFileSync(schemaFile, JSON.stringify(compiled.outputSchema), { mode: 0o600 });
          const args = [
            ...(options.binaryArgs ?? []),
            'exec',
            '--json',
            ...codexCompilerFlags(compiled, schemaFile),
            ...(process.platform === 'win32'
              ? ['-c', `windows.sandbox="${CODEX_WINDOWS_SANDBOX}"`]
              : []),
            '-C',
            req.worktreePath,
            ...(req.model ? ['-m', req.model] : []),
            '-',
          ];
          child = spawn(binary, args, {
            cwd: req.worktreePath,
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          const proc = child;
          let failure: Error | undefined;
          const completion = new Promise<number>((resolve) => {
            proc.on('error', (error) => {
              failure = error;
            });
            proc.on('close', (code) => resolve(code ?? 1));
          });
          proc.stdin!.on('error', () => {});
          proc.stdin!.end(compiled.codex.instructions);
          timer = setTimeout(() => {
            try {
              cancel();
            } catch {
              /* reported below */
            }
          }, req.timeoutMin * 60000);
          const queue: ExecutionEvent[] = [];
          let wake: (() => void) | undefined;
          const push = (event: ExecutionEvent) => {
            queue.push(event);
            wake?.();
          };
          let summary = '',
            sessionId = '',
            resultError = false,
            sawTurn = false;
          let tokenCountSeen = false;
          const readers = (['stdout', 'stderr'] as const).map(async (stream) => {
            for await (const line of createInterface({ input: proc[stream]! })) {
              if (stream === 'stderr') {
                push({ type: 'output', text: line, stream });
                continue;
              }
              let record;
              try {
                record = JSON.parse(line);
              } catch {
                push({ type: 'output', text: line, stream });
                continue;
              }
              if (!record?.type) {
                push({ type: 'output', text: line, stream });
                continue;
              }
              if (
                record?.type === 'thread.started' &&
                typeof record.thread_id === 'string' &&
                record.thread_id &&
                !sessionId
              ) {
                sessionId = record.thread_id;
                push({
                  type: 'started',
                  sessionId,
                  pid: proc.pid ?? 0,
                  startedAt: new Date().toISOString(),
                });
              }
              if (record?.type === 'item.completed' || record?.type === 'item.started') {
                const item = record.item;
                if (
                  item?.type === 'agent_message' &&
                  record.type === 'item.completed' &&
                  typeof item.text === 'string'
                ) {
                  summary = item.text;
                  push({ type: 'output', text: summary, stream });
                }
                if (
                  record.type === 'item.started' &&
                  ['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(
                    item?.type,
                  )
                )
                  push({ type: 'toolUse', toolId: item.id, toolName: item.type, input: item });
              }
              const payload = record?.type === 'event_msg' ? record.payload : record;
              if (payload?.type === 'token_count') {
                const usage = payload.info?.last_token_usage;
                if (usage) {
                  tokenCountSeen = true;
                  push({
                    type: 'usage',
                    inputTokens: usage.input_tokens ?? 0,
                    outputTokens: usage.output_tokens ?? 0,
                  });
                }
              }
              if (payload?.rate_limits) {
                const now = Date.now() / 1000;
                const quota = parseCodexRateLimits(payload.rate_limits, now);
                const reset = Math.max(
                  0,
                  ...[quota, quota.weekly]
                    .filter(
                      (window) =>
                        window && (window.usedPercent ?? 0) >= 100 && window.resetsAt !== null,
                    )
                    .map((window) => window!.resetsAt! - now),
                );
                push({
                  type: 'rateLimit',
                  message: quota.status,
                  retryAfterSec: quota.status === 'rejected' ? Math.ceil(reset) : 0,
                  capacity: quota.capacity,
                });
              }
              if (record?.type === 'turn.completed') {
                sawTurn = true;
                if (record.usage && !tokenCountSeen)
                  push({
                    type: 'usage',
                    inputTokens: record.usage.input_tokens ?? 0,
                    outputTokens: record.usage.output_tokens ?? 0,
                  });
                tokenCountSeen = false;
              }
              if (record?.type === 'turn.failed') {
                resultError = true;
                summary = record.error?.message ?? 'Codex turn failed';
              }
              if (record?.type === 'error') {
                push({ type: 'output', text: record.message ?? 'Codex error', stream });
                if (record.code === 'rate_limit_exceeded')
                  push({
                    type: 'rateLimit',
                    message: record.message,
                    retryAfterSec: record.retry_after_seconds ?? 0,
                  });
              }
            }
          });
          let closed = false,
            exitCode = 1;
          void Promise.allSettled([completion, ...readers]).then((results) => {
            const result = results[0];
            exitCode = result.status === 'fulfilled' ? (result.value as number) : 1;
            for (const r of results) if (r.status === 'rejected') failure = r.reason;
            closed = true;
            wake?.();
          });
          while (!closed || queue.length) {
            if (queue.length) yield queue.shift()!;
            else
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
          }
          if (!sessionId || !sawTurn) {
            resultError = true;
            summary ||= 'Codex exited without a session or completed turn';
          }
          if (compiled.outputSchema && !cancelled && !failure && !resultError) {
            try {
              if (!validateAgentOutput(compiled.outputSchema, JSON.parse(summary)))
                throw new Error();
            } catch {
              resultError = true;
              summary = 'Codex output failed schema validation';
            }
          }
          done = true;
          yield {
            type: 'finished',
            exitCode: cancelFailure ? 1 : cancelled ? 130 : failure || resultError ? 1 : exitCode,
            resultSummary:
              cancelFailure?.message ?? (cancelled ? 'Cancelled' : (failure?.message ?? summary)),
          };
        } finally {
          if (timer) clearTimeout(timer);
          try {
            if (!done) cancel();
          } finally {
            done = true;
            if (directory) fs.rmSync(directory, { recursive: true, force: true });
          }
        }
      })(),
    };
  }
}
