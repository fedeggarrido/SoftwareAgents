import { randomBytes } from 'crypto';
import * as fs from 'fs';

import type { ProjectOperatorConfig } from '../../core/src/project.js';
import {
  TELEMETRY_EXPORT_CONCURRENCY,
  TELEMETRY_EXPORT_TIMEOUT_MS,
  TELEMETRY_FILE_BYTES,
  TELEMETRY_LOCK_LEASE_MS,
  TELEMETRY_LOCK_TIMEOUT_MS,
  TELEMETRY_SPAN_BYTES,
  TELEMETRY_TOOL_LIMIT,
} from './constants.js';
import { withLeaseLock } from './leaseLock.js';
import { resolveInside } from './pathGuard.js';
import { telemetryName, type TelemetryObservation } from './telemetryObservations.js';

type Attributes = Record<string, string | number>;
export interface TelemetrySpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: { stringValue: string } | { intValue: string } }[];
  status: { code: number };
}
export function otlpSpan(span: TelemetrySpan) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'softwareagents' } }],
        },
        scopeSpans: [{ scope: { name: 'softwareagents.telemetry', version: '1' }, spans: [span] }],
      },
    ],
  };
}

export function telemetryDirectory(common: string, project: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project)) throw new Error('Invalid telemetry Project');
  return resolveInside(common, `softwareagents/telemetry/${project}`);
}

/** A shared, bounded append under a cross-process mutex. Rotation retains two files.
 * Telemetry is best effort; neither disk nor network failures change an Execution. */
export class TelemetrySink {
  dropped = 0;
  /** Spans the optional OTLP exporter skipped because it was saturated. */
  exportDropped = 0;
  private pending = new Set<Promise<void>>();
  constructor(
    private common: string,
    private project: string,
    private config?: ProjectOperatorConfig['telemetry'],
  ) {}

  write(span: TelemetrySpan): void {
    const body = JSON.stringify(otlpSpan(span));
    try {
      const dir = telemetryDirectory(this.common, this.project);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const lockDir = resolveInside(dir, 'locks');
      withLeaseLock(
        {
          dir: lockDir,
          name: 'append.lock',
          timeoutMs: TELEMETRY_LOCK_TIMEOUT_MS,
          leaseMs: TELEMETRY_LOCK_LEASE_MS,
          label: 'telemetry',
        },
        () => {
          const file = resolveInside(dir, 'spans.jsonl');
          const previous = resolveInside(dir, 'spans.1.jsonl');
          const bytes = Buffer.byteLength(body) + 1;
          if (bytes > TELEMETRY_SPAN_BYTES) throw new Error('Telemetry span too large');
          if (
            (fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) + bytes >
            TELEMETRY_FILE_BYTES
          ) {
            if (fs.existsSync(previous)) fs.unlinkSync(previous);
            fs.renameSync(file, previous);
          }
          const fd = fs.openSync(resolveInside(dir, 'spans.jsonl'), 'a', 0o600);
          try {
            fs.writeFileSync(fd, body + '\n');
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
        },
      );
    } catch {
      this.dropped++;
    }
    const exporter = this.config?.otlp;
    if (!exporter?.enabled) return;
    // One slot stays reserved for the root, so a saturated exporter never ships orphan children.
    const limit = span.parentSpanId
      ? TELEMETRY_EXPORT_CONCURRENCY - 1
      : TELEMETRY_EXPORT_CONCURRENCY;
    if (this.pending.size >= limit) {
      this.exportDropped++;
      return;
    }
    // No env-based OTEL config, retries, redirects, response logging or unbounded queue.
    const send = (async () => {
      try {
        const url = new URL(exporter.endpoint);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
        const response = await fetch(url, {
          method: 'POST',
          redirect: 'error',
          headers: { ...exporter.headers, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(TELEMETRY_EXPORT_TIMEOUT_MS),
        });
        await response.body?.cancel();
      } catch {
        /* optional exporter cannot fail the run or disclose credentials */
      }
    })();
    this.pending.add(send);
    void send.finally(() => this.pending.delete(send));
  }
  async flush(): Promise<void> {
    await Promise.allSettled(this.pending);
  }
}

const nano = (ms: number) => (BigInt(Math.floor(ms)) * 1_000_000n).toString();
const id = (bytes: number): string => {
  const value = randomBytes(bytes).toString('hex');
  return /^0+$/.test(value) ? id(bytes) : value;
};

export class ExecutionTelemetry {
  readonly traceId = id(16);
  readonly spanId = id(8);
  private attrs: Attributes;
  private tools = new Map<string, { spanId: string; name: string; start: number }>();
  private seen = new Set<string>();
  private phaseName = 'preparation';
  private phaseStart: number;
  private phases: Attributes = {};
  private ended = false;
  private completedRoot?: TelemetrySpan;
  /** Content-free root retained for the eval runner, independent of sink rotation/failures. */
  get rootSpan(): TelemetrySpan | undefined {
    return this.completedRoot;
  }
  /** Usage snapshot without ending the execution before commit guards settle. */
  get usageAttributes(): Readonly<Attributes> {
    return { ...this.attrs };
  }
  constructor(
    private sink: TelemetrySink,
    input: {
      executionId: string;
      taskKey: string;
      executor: string;
      agent: string;
      role: string;
      model?: string;
      tier?: string;
      effort?: string;
      cascade?: { attempt: number; escalatedFrom?: string };
    },
    private start = Date.now(),
  ) {
    this.phaseStart = start;
    this.attrs = {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.provider.name': input.executor === 'claude' ? 'anthropic' : 'openai',
    };
    if (input.cascade) {
      this.attrs['softwareagents.cascade.attempt'] = input.cascade.attempt;
      if (input.cascade.escalatedFrom)
        this.attrs['softwareagents.cascade.escalated_from'] = input.cascade.escalatedFrom;
    }
    for (const [key, value] of Object.entries({
      'softwareagents.execution.id': input.executionId,
      'softwareagents.task.key': input.taskKey,
      'softwareagents.executor': input.executor,
      'gen_ai.agent.name': input.agent,
      'softwareagents.agent.role': input.role,
      'gen_ai.request.model': input.model,
      'softwareagents.model.tier': input.tier,
      'softwareagents.model.effort': input.effort,
    })) {
      const name = telemetryName(value);
      if (name) this.attrs[key] = name;
    }
  }
  phase(name: 'execution' | 'commit_guards', time = Date.now()): void {
    this.phases[`softwareagents.phase.${this.phaseName}_ms`] = Math.max(0, time - this.phaseStart);
    this.phaseName = name;
    this.phaseStart = time;
  }
  observe(o: TelemetryObservation): void {
    if (this.ended) return;
    if (o.kind === 'model') {
      const name = telemetryName(o.model);
      if (name) {
        if (this.attrs['gen_ai.response.model'] && this.attrs['gen_ai.response.model'] !== name)
          this.attrs['softwareagents.model.multiple'] = 1;
        this.attrs['gen_ai.response.model'] = name;
      }
    } else if (o.kind === 'usage') {
      for (const [key, value] of Object.entries({
        input_tokens: o.input,
        output_tokens: o.output,
        'cache_read.input_tokens': o.cacheRead,
        'cache_creation.input_tokens': o.cacheCreate,
      }))
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
          this.attrs[`gen_ai.usage.${key}`] = value;
    } else if (o.kind === 'tool_start') {
      if (this.seen.has(o.id) || this.seen.size >= TELEMETRY_TOOL_LIMIT) return;
      this.seen.add(o.id);
      this.tools.set(o.id, {
        spanId: id(8),
        name: telemetryName(o.name) ?? 'unknown',
        start: o.time,
      });
    } else this.endTool(o.id, o.error ? 2 : 1, o.time);
  }
  private endTool(toolId: string, code: number, time: number, unobserved = false) {
    const tool = this.tools.get(toolId);
    if (!tool) return;
    this.tools.delete(toolId);
    this.emit(
      tool.spanId,
      'execute_tool',
      tool.start,
      time,
      code,
      {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': tool.name,
        'softwareagents.execution.id': this.attrs['softwareagents.execution.id'],
        'softwareagents.task.key': this.attrs['softwareagents.task.key'],
        ...(unobserved ? { 'softwareagents.tool.completion': 'unobserved' } : {}),
        ...(code === 2 ? { 'error.type': unobserved ? 'execution_error' : 'tool_error' } : {}),
      },
      this.spanId,
    );
  }
  private emit(
    spanId: string,
    name: string,
    start: number,
    end: number,
    code: number,
    attributes: Attributes,
    parentSpanId?: string,
  ) {
    const span: TelemetrySpan = {
      traceId: this.traceId,
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      name,
      kind: 1,
      startTimeUnixNano: nano(start),
      endTimeUnixNano: nano(Math.max(start, end)),
      status: { code },
      attributes: Object.entries(attributes)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => ({
          key,
          value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value },
        })),
    };
    this.sink.write(span);
    return span;
  }
  async finish(
    status: 'ok' | 'error' | 'require_human' = 'error',
    time = Date.now(),
  ): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    for (const key of this.tools.keys()) this.endTool(key, status === 'error' ? 2 : 0, time, true);
    this.phases[`softwareagents.phase.${this.phaseName}_ms`] = Math.max(0, time - this.phaseStart);
    this.completedRoot = this.emit(
      this.spanId,
      'invoke_agent',
      this.start,
      time,
      status === 'ok' ? 1 : 2,
      {
        ...this.attrs,
        ...this.phases,
        'softwareagents.execution.status': status,
        'softwareagents.telemetry.dropped_spans': this.sink.dropped,
        ...(this.seen.size >= TELEMETRY_TOOL_LIMIT
          ? { 'softwareagents.telemetry.tool_limit': 1 }
          : {}),
        ...(status === 'error' ? { 'error.type': 'execution_error' } : {}),
      },
    );
    await this.sink.flush();
  }
}
