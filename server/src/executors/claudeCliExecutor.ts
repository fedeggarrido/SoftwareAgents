import type { ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';

import {
  CLAUDE_DELEGATION_TOOLS,
  CLAUDE_MCP_TOOL_PREFIX,
  CLAUDE_WEB_TOOLS,
  compileAgent,
  validateAgentOutput,
} from '../agentCompiler.js';
import { extractJsonObject } from '../agentOutput.js';
import { claudeConfigEnvironment } from '../claudeConfig.js';
import {
  WEB_SCOUT_ENV_ALLOWLIST,
  WEB_SCOUT_ENV_PREFIX_ALLOWLIST,
  WEB_SCOUT_MAX_TURNS,
} from '../constants.js';
import { isQuotaDiagnostic } from '../executorQuotaState.js';
import { claudeEffortSupported, resolveClaudeBinary, validateModelChoice } from '../modelTiers.js';
import { getHookScriptPath, makeHookEntry } from '../providers/hook/claude/claudeHookInstaller.js';
import { CLAUDE_HOOK_EVENTS } from '../providers/hook/claude/constants.js';
import { parseClaudeRateLimit } from '../quotaReader.js';
import { CliTelemetryProjection } from '../telemetryObservations.js';
import {
  auditContainmentDenial,
  claudeToolContainment,
  CONTAINMENT_HOOK_TIMEOUT_SEC,
  type ContainmentContext,
  type ContainmentVerdict,
} from './agentContainment.js';
import type { ExecutionEvent, ExecutionHandle, ExecutionRequest, Executor } from './executor.js';
import { snapshotExecutionRequest } from './executor.js';
import { processCancellation } from './processCancellation.js';
import { spawnRegisteredProcess } from './registeredProcess.js';

export interface ClaudeCliExecutorOptions {
  configDir?: string;
  /** Trusted operator executable, not project content. Native executable on Windows. */
  binary: string;
  /** Operator argv prefix, e.g. node + fake-cli.cjs + claude in tests. */
  binaryArgs?: readonly string[];
  /** Private runtime storage outside the worktree, controlled by the Operator. */
  runtimeDirectory: string;
  /** Installed Pixel Agents hook command; omit to use the installer's default. */
  hookCommand?: string;
  /** Bundled SA-062 containment hook; omit to use dist/hooks/containment-hook.js. */
  containmentHookScript?: string;
}

/** The bundled CLI sits next to dist/hooks; running from source uses the built copy. */
export function containmentHookScriptPath(): string {
  const bundled = path.join(__dirname, 'hooks', 'containment-hook.js');
  return fs.existsSync(bundled)
    ? bundled
    : path.resolve(__dirname, '../../../dist/hooks/containment-hook.js');
}

/** Managed memory cannot be excluded by claudeMdExcludes. Never inspect its contents. */
export function assertScoutHasNoManagedMemory(): void {
  const managed =
    process.platform === 'win32'
      ? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ClaudeCode', 'CLAUDE.md')
      : process.platform === 'darwin'
        ? '/Library/Application Support/ClaudeCode/CLAUDE.md'
        : '/etc/claude-code/CLAUDE.md';
  try {
    fs.statSync(managed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Cannot establish absence of managed scout memory');
  }
  throw new Error('Web scout cannot load managed CLAUDE.md');
}

/** Claude runs hook commands through a shell. Paths are quoted, so characters a shell still
 * expands inside double quotes are refused instead of escaped. Under Electron, execPath is the
 * editor, not Node. */
function containmentHookCommand(script: string, contextFile: string): string {
  const node = process.versions.electron ? 'node' : process.execPath;
  const quote = (value: string) => {
    const portable = process.platform === 'win32' ? value.replace(/\\/g, '/') : value;
    if (/["$`\\\x00-\x1f%!]/.test(portable)) throw new Error('Unsafe containment hook path');
    return `"${portable}"`;
  };
  return [node, script, contextFile].map(quote).join(' ');
}

/** Configuration isolation is not an OS sandbox. Caller argv never grants authority. */
export class ClaudeCliExecutor implements Executor {
  readonly id = 'claude' as const;
  constructor(private readonly options: ClaudeCliExecutorOptions) {}

  start(req: ExecutionRequest): ExecutionHandle {
    req = snapshotExecutionRequest(req);
    const options = req.effort
      ? {
          ...this.options,
          binaryArgs: [...(this.options.binaryArgs ?? [])],
          binary: resolveClaudeBinary(this.options.binary),
        }
      : { ...this.options, binaryArgs: [...(this.options.binaryArgs ?? [])] };
    validateModelChoice(
      req,
      'claude',
      req.effort ? claudeEffortSupported(options.binary, options.configDir) : [],
    );
    if (req.flags.length || (!req.agentSpec && req.role !== 'developer')) {
      throw new Error('Caller flags are forbidden; non-Developer roles require an AgentSpec');
    }
    // Compatibility with the SA-033 smoke: its explicitly selected Developer ceiling
    // goes through the same compiler, without loading project or user configuration.
    const compiled = compileAgent(
      req.agentSpec ?? {
        apiVersion: 'softwareagents.io/v1alpha1',
        kind: 'AgentSpec',
        metadata: {
          id: 'developer',
          version: '1.0.0',
          displayName: 'Developer',
          department: 'engineering',
        },
        identity: {
          role: 'developer',
          mission: 'Implement the assigned task',
          principles: [],
          antiPatterns: [],
        },
        outputs: ['changes', 'verification'],
        permissions: { profile: 'branch_write' },
        modelPolicy: { capabilityClass: 'coding', fallbackAllowed: false },
        context: { brainPaths: [] },
        gates: { mayBlock: [] },
        escalation: { humanRequired: [] },
      },
      req.role,
      req.taskData ?? { task: { key: req.taskKey, content: req.prompt } },
    );
    if (!Number.isFinite(req.timeoutMin) || req.timeoutMin <= 0) throw new Error('Invalid timeout');
    if (
      req.researchBudget &&
      (!Number.isFinite(req.researchBudget.maxCostUsd) || req.researchBudget.maxCostUsd <= 0)
    )
      throw new Error('Invalid research budget');
    const sessionId = randomUUID();
    const containment: ContainmentContext = {
      worktreeRoot: req.worktreePath,
      projectId: req.projectId,
      taskKey: req.taskKey,
      executionId: req.executionId,
      executor: 'claude',
    };
    let child: ChildProcess | undefined;
    let done = false;
    let violation: string | undefined;
    let timedOut = false;
    const cancellation = processCancellation(() => child);
    const cancel = () => {
      if (!done) cancellation.cancel();
    };
    return {
      sessionId,
      cancel,
      events: (async function* (): AsyncGenerator<ExecutionEvent> {
        let directory: string | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (cancellation.requested) {
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
          if (req.role === 'web-scout') assertScoutHasNoManagedMemory();
          const settings = path.join(directory, compiled.claude.settingsFile);
          const mcp = path.join(directory, 'mcp.json');
          const hooksAvailable = fs.existsSync(getHookScriptPath());
          // SA-062: containment is mandatory, unlike the consent-gated office hooks.
          const containmentScript = options.containmentHookScript ?? containmentHookScriptPath();
          if (!fs.statSync(containmentScript, { throwIfNoEntry: false })?.isFile())
            throw new Error('Containment hook is not built; refusing to launch Claude');
          const contextFile = path.join(directory, 'containment.json');
          fs.writeFileSync(contextFile, JSON.stringify(containment), { mode: 0o600 });
          const office: Record<string, unknown[]> = hooksAvailable
            ? Object.fromEntries(
                CLAUDE_HOOK_EVENTS.map((event) => [event, [makeHookEntry(options.hookCommand)]]),
              )
            : {};
          fs.writeFileSync(
            settings,
            JSON.stringify({
              ...(req.role === 'web-scout'
                ? {
                    claudeMdExcludes: ['**'],
                    autoMemoryEnabled: false,
                  }
                : {}),
              hooks: {
                ...office,
                PreToolUse: [
                  {
                    matcher: '',
                    hooks: [
                      {
                        type: 'command',
                        command: containmentHookCommand(containmentScript, contextFile),
                        timeout: CONTAINMENT_HOOK_TIMEOUT_SEC,
                      },
                    ],
                  },
                  ...(office.PreToolUse ?? []),
                ],
              },
              permissions: { defaultMode: compiled.claude.permissionMode },
            }),
            { mode: 0o600 },
          );
          fs.writeFileSync(mcp, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
          const tools = compiled.claude.allowedTools.join(',');
          const args = [
            ...(options.binaryArgs ?? []),
            // Keep subscription OAuth: --bare would require an API key.
            ...(req.role === 'web-scout'
              ? ['--no-session-persistence', '--max-turns', String(WEB_SCOUT_MAX_TURNS)]
              : []),
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
            '--disallowedTools',
            compiled.claude.disallowedTools.join(','),
            req.role === 'web-scout' ? '--system-prompt' : '--append-system-prompt',
            compiled.claude.appendSystemPrompt,
            '--permission-mode',
            compiled.claude.permissionMode,
            '--no-chrome',
            '--disable-slash-commands',
            ...(req.model ? ['--model', req.model] : []),
            ...(req.effort ? ['--effort', req.effort] : []),
            ...(req.researchBudget
              ? ['--max-budget-usd', String(req.researchBudget.maxCostUsd)]
              : []),
          ];
          const configEnvironment = claudeConfigEnvironment(options.configDir);
          const environment =
            req.role === 'web-scout'
              ? Object.fromEntries(
                  Object.entries({ ...process.env, ...configEnvironment }).filter(([key]) => {
                    const name = key.toUpperCase();
                    return (
                      WEB_SCOUT_ENV_ALLOWLIST.some((allowed) => name === allowed) ||
                      WEB_SCOUT_ENV_PREFIX_ALLOWLIST.some((prefix) => name.startsWith(prefix))
                    );
                  }),
                )
              : configEnvironment;
          child = spawnRegisteredProcess(
            options.binary,
            args,
            req.role === 'web-scout' ? directory : req.worktreePath,
            req.registerProcess,
            req.persistProcessClose,
            environment,
            req.role === 'web-scout' ? 'replace' : 'inherit',
          );
          const processChild = child;
          let failure: Error | undefined;
          const completion = new Promise<number>((resolve) => {
            processChild.on('error', (error) => {
              failure = error;
            });
            processChild.on('close', (code) => {
              cancellation.confirmClose();
              resolve(code ?? 1);
            });
          });
          processChild.stdin!.on('error', () => {
            /* premature process exit */
          });
          processChild.stdin!.end(compiled.context);
          timer = setTimeout(() => {
            timedOut = !cancellation.requested;
            try {
              cancel();
            } catch {
              /* surfaced after the process closes */
            }
          }, req.timeoutMin * 60_000);
          const queue: ExecutionEvent[] = [
            { type: 'telemetry', observation: { kind: 'prefix', hash: compiled.prefixHash } },
          ];
          const telemetry = new CliTelemetryProjection();
          let usageInput = 0;
          let usageOutput = 0;
          let usageObserved = false;
          let wake: (() => void) | undefined;
          const push = (event: ExecutionEvent) => {
            queue.push(event);
            wake?.();
          };
          // Tripwire for tools outside the compiled policy, including the scout exception.
          const violate = (detail: string) => {
            if (violation) return;
            violation = `Policy violation: ${detail}`;
            push({ type: 'output', stream: 'stdout', text: violation });
            try {
              cancel();
            } catch {
              /* surfaced after the process closes */
            }
          };
          const pendingContained = new Map<
            string,
            { verdict: ContainmentVerdict; toolName: string; input: unknown }
          >();
          const auditAttempt = (attempt: {
            verdict: ContainmentVerdict;
            toolName: string;
            input: unknown;
          }) => {
            if (attempt.verdict.allowed) return;
            try {
              auditContainmentDenial(containment, attempt.verdict, attempt.toolName, attempt.input);
            } catch {
              // Audit failures must never turn a containment failure into success.
              push({
                type: 'output',
                stream: 'stderr',
                text: 'Containment audit persistence failed',
              });
            }
          };
          let contained: ContainmentVerdict;
          const readers = (['stdout', 'stderr'] as const).map(async (stream) => {
            for await (const line of createInterface({ input: processChild[stream]! })) {
              if (stream === 'stderr') {
                if (isQuotaDiagnostic(line))
                  push({ type: 'rateLimit', message: 'rejected', retryAfterSec: 0 });
                push({ type: 'output', text: line, stream });
                continue;
              }
              try {
                const record = JSON.parse(line);
                if (record.type === 'assistant' && record.error === 'rate_limit')
                  push({ type: 'rateLimit', message: 'rejected', retryAfterSec: 0 });
                for (const observation of telemetry.claude(record)) {
                  push({ type: 'telemetry', observation });
                  if (observation.kind === 'usage') {
                    // The projection deduplicates assistant message IDs and includes cache
                    // tokens. Emit only deltas; final result totals reconcile missing usage.
                    const inputTokens = Math.max(0, observation.input - usageInput);
                    const outputTokens = Math.max(0, observation.output - usageOutput);
                    if (!usageObserved || inputTokens || outputTokens)
                      push({ type: 'usage', inputTokens, outputTokens });
                    usageInput += inputTokens;
                    usageOutput += outputTokens;
                    usageObserved = true;
                  }
                }
                if (!record?.type) {
                  push({ type: 'output', text: line, stream });
                  continue;
                }
                if (record.type === 'system' && record.subtype === 'init') {
                  const tools: unknown[] = Array.isArray(record.tools) ? record.tools : [];
                  const web = tools.filter(
                    (tool) => typeof tool === 'string' && CLAUDE_WEB_TOOLS.includes(tool),
                  );
                  const mcp = tools.filter(
                    (tool) => typeof tool === 'string' && tool.startsWith(CLAUDE_MCP_TOOL_PREFIX),
                  );
                  const delegation = tools.filter(
                    (tool) => typeof tool === 'string' && CLAUDE_DELEGATION_TOOLS.includes(tool),
                  );
                  const servers: unknown[] = Array.isArray(record.mcp_servers)
                    ? record.mcp_servers
                    : [];
                  if (req.role === 'web-scout' && tools.some((tool) => tool !== 'WebSearch'))
                    violate('Web scout exposed tools outside WebSearch');
                  else if (web.some((tool) => !compiled.claude.allowedTools.includes(String(tool))))
                    violate(`Claude exposed ${web.join(', ')}; slice profiles have no web access`);
                  else if (mcp.length || servers.length)
                    violate(
                      `Claude exposed MCP (${[...mcp, ...servers.map((server) => (server as { name?: unknown })?.name ?? 'server')].join(', ')}); slice profiles have no MCP`,
                    );
                  else if (delegation.length)
                    violate(
                      `Claude exposed ${delegation.join(', ')}; slice profiles have no delegated agents`,
                    );
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
                    if (content.type === 'tool_use') {
                      if (req.role === 'web-scout' && content.name !== 'WebSearch')
                        violate('Web scout used tools outside WebSearch');
                      else if (
                        CLAUDE_WEB_TOOLS.includes(content.name) &&
                        !compiled.claude.allowedTools.includes(content.name)
                      )
                        violate(`Claude used ${content.name}; slice profiles have no web access`);
                      else if (
                        typeof content.name === 'string' &&
                        content.name.startsWith(CLAUDE_MCP_TOOL_PREFIX)
                      )
                        violate(
                          `Claude called MCP tool ${content.name}; slice profiles have no MCP`,
                        );
                      else if (CLAUDE_DELEGATION_TOOLS.includes(content.name))
                        violate(
                          `Claude used ${content.name}; slice profiles have no delegated agents`,
                        );
                      else if (
                        !(contained = claudeToolContainment(
                          content.name,
                          content.input,
                          req.worktreePath,
                        )).allowed
                      ) {
                        // The hook denies and audits it; the input is never forwarded (may hold
                        // credentials). Its tool_result must come back as an error.
                        pendingContained.set(content.id, {
                          verdict: contained,
                          toolName: String(content.name),
                          input: content.input,
                        });
                        push({
                          type: 'output',
                          stream,
                          text: `Containment: ${content.name} denied (${contained.rule})`,
                        });
                      } else
                        push({
                          type: 'toolUse',
                          toolId: content.id,
                          toolName: content.name,
                          input: content.input,
                        });
                    }
                    if (content.type === 'text')
                      push({ type: 'output', text: content.text, stream });
                  }
                }
                // Tripwire: a contained tool that did not come back as an error means the
                // hook failed open (missing node, timeout, hooks disabled by managed policy).
                if (record.type === 'user') {
                  const results: unknown[] = Array.isArray(record.message?.content)
                    ? record.message.content
                    : [];
                  for (const result of results) {
                    const {
                      type,
                      tool_use_id: id,
                      is_error: isError,
                    } = (result ?? {}) as Record<string, unknown>;
                    if (type !== 'tool_result' || typeof id !== 'string') continue;
                    const attempt = pendingContained.get(id);
                    if (!attempt) continue;
                    pendingContained.delete(id);
                    if (isError === true || attempt.verdict.allowed) continue;
                    auditAttempt(attempt);
                    violate(
                      `Claude ran ${attempt.toolName} despite agent containment (${attempt.verdict.rule})`,
                    );
                  }
                }
                if (record.type === 'result') {
                  // Cost is CLI metadata, never parsed from model-authored report text.
                  costUsd =
                    typeof record.total_cost_usd === 'number' &&
                    Number.isFinite(record.total_cost_usd) &&
                    record.total_cost_usd >= 0
                      ? record.total_cost_usd
                      : undefined;
                  summary = record.result || record.errors?.join('\n') || '';
                  resultError = record.is_error === true;
                  if (resultError && isQuotaDiagnostic(summary))
                    push({ type: 'rateLimit', message: 'rejected', retryAfterSec: 0 });
                  if (compiled.outputSchema && !resultError) {
                    try {
                      // Models sometimes return the JSON as a ```json text block instead of
                      // structured output (the researcher did, every run); extract it.
                      const output =
                        record.structured_output ??
                        JSON.parse(req.role === 'web-scout' ? summary : extractJsonObject(summary));
                      if (!validateAgentOutput(compiled.outputSchema, output))
                        throw new Error('Schema mismatch');
                      summary = JSON.stringify(output);
                    } catch {
                      resultError = true;
                      summary = 'Claude output failed schema validation';
                    }
                  }
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
                    capacity: quota.capacity,
                  });
                }
              } catch {
                if (isQuotaDiagnostic(line))
                  push({ type: 'rateLimit', message: 'rejected', retryAfterSec: 0 });
                push({ type: 'output', text: line, stream });
              }
            }
          });
          let summary = '';
          let costUsd: number | undefined;
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
            // A missing tool_result cannot confirm that the hook blocked the attempt. Audit
            // every unresolved call after both streams drain, and fail even on CLI exit 0.
            for (const attempt of pendingContained.values()) {
              auditAttempt(attempt);
              if (!attempt.verdict.allowed)
                violate(
                  `Claude ended without a tool_result for ${attempt.toolName} (${attempt.verdict.rule})`,
                );
            }
            pendingContained.clear();
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
            ...(costUsd !== undefined ? { costUsd } : {}),
            exitCode:
              cancellation.failure || violation
                ? 1
                : cancellation.requested
                  ? 130
                  : resultError || failure
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
          // Setup and synchronous spawn failures leave no process to confirm or cancel.
          if (child) throw error;
          done = true;
          yield {
            type: 'finished',
            exitCode: 1,
            resultSummary: error instanceof Error ? error.message : String(error),
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
