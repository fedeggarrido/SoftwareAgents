import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';

import type { ProjectOperatorConfig } from '../../../core/src/project.js';
import {
  CODEX_DELEGATION_ITEM_TYPES,
  CODEX_MCP_EVENT_TYPES,
  CODEX_WEB_EVENT_TYPES,
  codexCompilerFlags,
  compileAgent,
  executorSupportsRole,
  shellProfileBaseline,
  validateAgentOutput,
  windowsShellBaseline,
} from '../agentCompiler.js';
import {
  CODEX_REPO_CONFIG_DIRS,
  CODEX_SUBAGENT_FINAL_RETRY_MS,
  CODEX_SUBAGENT_FINAL_TIMEOUT_MS,
  CODEX_SUBAGENT_POLL_MS,
  CODEX_WINDOWS_SANDBOX,
  TELEMETRY_ROLLOUT_BYTES,
} from '../constants.js';
import { isQuotaDiagnostic } from '../executorQuotaState.js';
import { validateModelChoice } from '../modelTiers.js';
import { parseCodexRateLimits } from '../quotaReader.js';
import { CliTelemetryProjection } from '../telemetryObservations.js';
import { auditContainmentDenial, codexItemContainment } from './agentContainment.js';
import { codexSessionsDirectory, findSubagentRollout } from './codexSubagents.js';
import type { ExecutionEvent, ExecutionHandle, ExecutionRequest, Executor } from './executor.js';
import { snapshotExecutionRequest } from './executor.js';
import { processCancellation } from './processCancellation.js';
import { spawnRegisteredProcess } from './registeredProcess.js';

/** `server.tool` of an MCP call record (exec item or envelope), for the violation message. */
function codexMcpToolName(shape: {
  server?: unknown;
  tool?: unknown;
  invocation?: { server?: unknown; tool?: unknown };
}): string {
  const server = shape.server ?? shape.invocation?.server;
  const tool = shape.tool ?? shape.invocation?.tool;
  return typeof server === 'string' && typeof tool === 'string' ? `${server}.${tool}` : 'unknown';
}

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
  /** Codex rollout root watched for sub-agents; defaults to $CODEX_HOME/sessions. */
  sessionsDirectory?: string;
}

export class CodexCliExecutor implements Executor {
  readonly id = 'codex' as const;
  constructor(private readonly options: CodexCliExecutorOptions) {}
  start(req: ExecutionRequest): ExecutionHandle {
    req = snapshotExecutionRequest(req);
    if (!executorSupportsRole('codex', req.role))
      throw new Error(
        'code_execution_not_mediated: Codex cannot run QA/Reviewer without shell mediation',
      );
    validateModelChoice(req, 'codex');
    if (req.flags.length) throw new Error('Caller flags are forbidden');
    if (!req.agentSpec) throw new Error('Codex requires an AgentSpec');
    if (!Number.isFinite(req.timeoutMin) || req.timeoutMin <= 0) throw new Error('Invalid timeout');
    // Synchronous preflight: no handle/process exists, so the worker can release its task lock.
    for (const shipped of CODEX_REPO_CONFIG_DIRS)
      if (fs.existsSync(path.join(req.worktreePath, shipped)))
        throw new Error(
          `Refusing to run Codex: the worktree ships ${shipped}/ (repository-provided Codex configuration or skills)`,
        );
    const compiled = compileAgent(
      req.agentSpec,
      req.role,
      req.taskData ?? { task: { key: req.taskKey, content: req.prompt } },
    );
    const binary = resolveCodexBinary(this.options.operator);
    const options = { ...this.options, binaryArgs: [...(this.options.binaryArgs ?? [])] };
    let child: ChildProcess | undefined;
    let done = false;
    let violation: string | undefined;
    let correctionCandidate: string | undefined;
    const cancellation = processCancellation(() => child);
    const cancel = () => {
      if (!done) cancellation.cancel();
    };
    return {
      cancel,
      events: (async function* (): AsyncGenerator<ExecutionEvent> {
        let directory: string | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (cancellation.requested) {
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
          // Private shell profile for the agent (caches, temp), outside the worktree.
          const shellHome =
            process.platform === 'win32' ? path.join(directory, 'shell-home') : undefined;
          if (shellHome)
            for (const sub of ['AppData/Roaming', 'AppData/Local', 'Temp', 'npm-cache'])
              fs.mkdirSync(path.join(shellHome, sub), { recursive: true });
          if (compiled.outputSchema)
            fs.writeFileSync(schemaFile, JSON.stringify(compiled.outputSchema), { mode: 0o600 });
          const args = [
            ...(options.binaryArgs ?? []),
            'exec',
            '--json',
            ...codexCompilerFlags(compiled, schemaFile),
            // inherit="none" leaves Windows without SystemRoot, which breaks the crypto
            // provider: Node aborts (CSPRNG) and PowerShell fails with 8009001d. Re-add only
            // non-secret system variables; credentials stay out of the agent's shell.
            ...[
              ...windowsShellBaseline(),
              ...(shellHome ? shellProfileBaseline(shellHome) : []),
            ].flatMap(([name, value]) => [
              '-c',
              `shell_environment_policy.set.${name}=${JSON.stringify(value)}`,
            ]),
            ...(shellHome
              ? ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([shellHome])}`]
              : []),
            ...(process.platform === 'win32'
              ? ['-c', `windows.sandbox="${CODEX_WINDOWS_SANDBOX}"`]
              : []),
            '-C',
            req.worktreePath,
            ...(req.model ? ['-m', req.model] : []),
            ...(req.effort ? ['-c', `model_reasoning_effort="${req.effort}"`] : []),
            '-',
          ];
          const launchedMs = Date.now();
          child = spawnRegisteredProcess(
            binary,
            args,
            req.worktreePath,
            req.registerProcess,
            req.persistProcessClose,
          );
          const proc = child;
          let failure: Error | undefined;
          const completion = new Promise<number>((resolve) => {
            proc.on('error', (error) => {
              failure = error;
            });
            proc.on('close', (code) => {
              cancellation.confirmClose();
              resolve(code ?? 1);
            });
          });
          proc.stdin!.on('error', () => {});
          proc.stdin!.end(compiled.codex.instructions);
          let timedOut = false;
          timer = setTimeout(() => {
            timedOut = !cancellation.requested;
            try {
              cancel();
            } catch {
              /* reported below */
            }
          }, req.timeoutMin * 60000);
          const queue: ExecutionEvent[] = [
            { type: 'telemetry', observation: { kind: 'prefix', hash: compiled.codex.prefixHash } },
          ];
          const telemetry = new CliTelemetryProjection();
          let ownRollout: string | undefined;
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
          let watcher: ReturnType<typeof setInterval> | undefined;
          const violate = (detail: string) => {
            if (violation) {
              if (violation !== `Policy violation: ${detail}`) correctionCandidate = undefined;
              return;
            }
            violation = `Policy violation: ${detail}`;
            push({ type: 'output', text: violation, stream: 'stdout' });
            try {
              cancel();
            } catch {
              /* reported below */
            }
          };
          // No 0.160.0 flag stops delegation, and a spawn without a wait never reaches the exec
          // stream: the sub-agent's own rollout (parent_thread_id = our thread) is the signal.
          const sessionsRoot =
            options.sessionsDirectory ?? codexSessionsDirectory(process.env, req.worktreePath);
          const seenRollouts = new Set<string>();
          const auditedContained = new Set<string>();
          const checkSubagents = (final = false) => {
            if (!sessionId || violation) return;
            const rollout = findSubagentRollout(
              sessionsRoot,
              sessionId,
              launchedMs,
              seenRollouts,
              Date.now(),
              final,
              (file) => {
                ownRollout = file;
              },
            );
            if (rollout.status === 'found')
              violate(
                `Codex spawned a sub-agent (${path.basename(rollout.file)}); slice profiles have no delegated agents`,
              );
            return rollout;
          };
          const readers = (['stdout', 'stderr'] as const).map(async (stream) => {
            for await (const line of createInterface({ input: proc[stream]! })) {
              if (stream === 'stderr') {
                if (isQuotaDiagnostic(line))
                  push({ type: 'rateLimit', message: 'rejected', retryAfterSec: 0 });
                push({ type: 'output', text: line, stream });
                continue;
              }
              let record;
              try {
                record = JSON.parse(line);
              } catch {
                if (isQuotaDiagnostic(line))
                  push({ type: 'rateLimit', message: 'rejected', retryAfterSec: 0 });
                push({ type: 'output', text: line, stream });
                continue;
              }
              for (const observation of telemetry.codex(record))
                push({ type: 'telemetry', observation });
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
                watcher ??= setInterval(() => checkSubagents(), CODEX_SUBAGENT_POLL_MS);
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
              }
              // The compiled flags should make web and MCP tools unreachable, in the exec item
              // stream or the rollout envelope; seeing one means a flag did not apply (SA-074,
              // SA-QA-4), so the run is stopped and never trusted.
              const shapes = [
                record.type === 'item.started' || record.type === 'item.completed'
                  ? record.item
                  : undefined,
                record.type === 'event_msg' || record.type === 'response_item'
                  ? record.payload
                  : undefined,
              ];
              const web = shapes.find((shape) => CODEX_WEB_EVENT_TYPES.includes(shape?.type));
              const mcp = shapes.find((shape) => CODEX_MCP_EVENT_TYPES.includes(shape?.type));
              const delegation = shapes.find((shape) =>
                CODEX_DELEGATION_ITEM_TYPES.includes(shape?.type),
              );
              if (web)
                violate(
                  `Codex used ${web.type} despite web_search="${compiled.codex.webSearch}"; slice profiles have no web access`,
                );
              else if (mcp)
                violate(
                  `Codex called MCP tool ${codexMcpToolName(mcp)} despite features ${compiled.codex.disabledFeatures.join(', ')} off; slice profiles have no MCP`,
                );
              else if (delegation)
                violate(
                  `Codex delegated to a sub-agent (${typeof delegation.tool === 'string' ? delegation.tool : delegation.type}); slice profiles have no delegated agents`,
                );
              // SA-062: no pre-execution hook exists in Codex; the sandbox (no network, .git
              // outside the writable roots) enforces, and an attempt stops and fails the run.
              const item =
                record.type === 'item.started' || record.type === 'item.completed'
                  ? record.item
                  : undefined;
              const contained = codexItemContainment(item, req.worktreePath);
              if (!contained.allowed) {
                const key = typeof item?.id === 'string' ? item.id : JSON.stringify(item);
                if (!auditedContained.has(key)) {
                  auditedContained.add(key);
                  if (
                    !violation &&
                    item?.type === 'command_execution' &&
                    ['protected_write', 'outside_worktree'].includes(contained.rule)
                  )
                    correctionCandidate = contained.reason;
                  try {
                    auditContainmentDenial(
                      {
                        worktreeRoot: req.worktreePath,
                        projectId: req.projectId,
                        taskKey: req.taskKey,
                        executionId: req.executionId,
                        executor: 'codex',
                      },
                      contained,
                      String(item.type),
                      item,
                    );
                  } catch {
                    correctionCandidate = undefined;
                    // The violation below still fails the run.
                    push({
                      type: 'output',
                      stream: 'stderr',
                      text: 'Containment audit persistence failed',
                    });
                  }
                }
                violate(`Codex attempted ${contained.rule}; ${contained.reason}`);
              } else if (!web && !mcp && !delegation && record.type === 'item.started') {
                if (['command_execution', 'file_change'].includes(item?.type))
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
                if (isQuotaDiagnostic(summary))
                  push({
                    type: 'rateLimit',
                    message: 'rejected',
                    retryAfterSec: record.error?.retry_after_seconds ?? 0,
                  });
              }
              if (record?.type === 'error') {
                push({ type: 'output', text: record.message ?? 'Codex error', stream });
                if (
                  record.code === 'rate_limit_exceeded' ||
                  isQuotaDiagnostic(record.message ?? '')
                )
                  push({
                    type: 'rateLimit',
                    message: 'rejected',
                    retryAfterSec: record.retry_after_seconds ?? 0,
                  });
              }
            }
          });
          let closed = false,
            exitCode = 1;
          void Promise.allSettled([completion, ...readers]).then(async (results) => {
            const result = results[0];
            exitCode = result.status === 'fulfilled' ? (result.value as number) : 1;
            for (const r of results) if (r.status === 'rejected') failure = r.reason;
            if (watcher) clearInterval(watcher);
            // Closure confirms termination; the remaining timeout must not turn a clean
            // result into cancellation while we wait for a concurrent rollout writer.
            if (timer) clearTimeout(timer);
            const deadline = Date.now() + CODEX_SUBAGENT_FINAL_TIMEOUT_MS;
            let rollout = checkSubagents(true);
            while (rollout?.status === 'inconclusive' && Date.now() < deadline) {
              await new Promise<void>((resolve) =>
                setTimeout(resolve, Math.min(CODEX_SUBAGENT_FINAL_RETRY_MS, deadline - Date.now())),
              );
              rollout = checkSubagents(true);
            }
            if (rollout?.status === 'inconclusive')
              violate(`could not verify that no sub-agent was spawned: ${rollout.reason}`);
            // Bounded, best-effort read of this thread only. Totals replace stream totals,
            // never add to them; rollout content and paths are not emitted.
            if (ownRollout) {
              try {
                const size = fs.statSync(ownRollout).size;
                const input = fs.createReadStream(ownRollout, {
                  start: Math.max(0, size - TELEMETRY_ROLLOUT_BYTES),
                  end: Math.max(0, size - 1),
                });
                for await (const line of createInterface({ input })) {
                  try {
                    for (const observation of telemetry.codex(JSON.parse(line), true))
                      push({ type: 'telemetry', observation });
                  } catch {
                    /* incomplete or unsupported rollout record */
                  }
                }
              } catch {
                /* telemetry must not affect execution */
              }
            }
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
          if (compiled.outputSchema && !cancellation.requested && !failure && !resultError) {
            try {
              if (!validateAgentOutput(compiled.outputSchema, JSON.parse(summary)))
                throw new Error();
            } catch {
              resultError = true;
              summary = 'Codex output failed schema validation';
            }
          }
          done = true;
          if (
            correctionCandidate &&
            !failure &&
            !cancellation.failure &&
            violation?.startsWith('Policy violation: Codex attempted ')
          )
            yield { type: 'guardCorrection', diagnostic: correctionCandidate };
          yield {
            type: 'finished',
            exitCode:
              cancellation.failure || violation
                ? 1
                : cancellation.requested
                  ? 130
                  : failure || resultError
                    ? 1
                    : exitCode,
            resultSummary:
              [violation, cancellation.failure?.message].filter(Boolean).join('; ') ||
              (cancellation.requested
                ? timedOut
                  ? 'Timed out'
                  : 'Cancelled'
                : (failure?.message ?? summary)),
          };
        } catch (error) {
          // No process exists when setup or spawn throws synchronously. Report completion
          // so the worker can release its lock; post-spawn failures still require close.
          if (child) throw error;
          done = true;
          yield {
            type: 'finished',
            exitCode: 1,
            resultSummary: error instanceof Error ? error.message : String(error),
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
