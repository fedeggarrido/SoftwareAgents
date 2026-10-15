import { TELEMETRY_IDENTIFIER_LENGTH, TELEMETRY_MESSAGE_LIMIT } from './constants.js';

/** Content-free projection at the CLI boundary. Raw records never reach the sink. */
export type TelemetryObservation =
  | { kind: 'model'; model: string }
  | { kind: 'usage'; input: number; output: number; cacheRead?: number; cacheCreate?: number }
  | { kind: 'tool_start'; id: string; name: string; time: number }
  | { kind: 'tool_end'; id: string; error: boolean; time: number };

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const hasUsage = (value: unknown): boolean => {
  const usage = obj(value);
  return [usage.input_tokens, usage.output_tokens].every(
    (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0,
  );
};
const items = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
// Built-in names are a closed vocabulary. In particular, dynamic MCP names can
// contain user-controlled text; retain only their category, never the raw label.
const claudeTools = new Set([
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'Bash',
  'NotebookEdit',
  'Agent',
  'Task',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'ToolSearch',
]);

/** Only identifiers; never paths, error messages, tool arguments or model text. */
export function telemetryName(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= TELEMETRY_IDENTIFIER_LENGTH &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value)
    ? value
    : undefined;
}

export class CliTelemetryProjection {
  private messages = new Map<string, ReturnType<CliTelemetryProjection['claudeUsage']>>();
  private codexInput = 0;
  private codexOutput = 0;
  private codexCache = 0;
  private tokenCountSeen = false;

  private claudeUsage(value: unknown) {
    const u = obj(value);
    const cacheRead = count(u.cache_read_input_tokens);
    const cacheCreate = count(u.cache_creation_input_tokens);
    return {
      input: count(u.input_tokens) + cacheRead + cacheCreate,
      output: count(u.output_tokens),
      cacheRead,
      cacheCreate,
    };
  }

  claude(value: unknown): TelemetryObservation[] {
    const r = obj(value),
      message = obj(r.message);
    const out: TelemetryObservation[] = [];
    const model = telemetryName(message.model ?? (r.type === 'system' ? r.model : undefined));
    if (model) out.push({ kind: 'model', model });
    if (r.type === 'assistant') {
      if (
        hasUsage(message.usage) &&
        typeof message.id === 'string' &&
        (this.messages.has(message.id) || this.messages.size < TELEMETRY_MESSAGE_LIMIT)
      ) {
        // A streamed message may be repeated with more blocks: replace, never sum duplicates.
        this.messages.set(message.id, this.claudeUsage(message.usage));
        const total = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
        for (const usage of this.messages.values())
          for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += usage[key];
        out.push({ kind: 'usage', ...total });
      }
      for (const block of items(message.content)) {
        const b = obj(block);
        if (b.type === 'tool_use' && typeof b.id === 'string')
          out.push({
            kind: 'tool_start',
            id: b.id,
            name: typeof b.name === 'string' && claudeTools.has(b.name) ? b.name : 'unknown',
            time: Date.now(),
          });
      }
    }
    if (r.type === 'user')
      for (const block of items(message.content)) {
        const b = obj(block);
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string')
          out.push({
            kind: 'tool_end',
            id: b.tool_use_id,
            error: b.is_error === true,
            time: Date.now(),
          });
      }
    // Result totals replace message totals, including after partial/failed runs.
    if (r.type === 'result' && hasUsage(r.usage))
      out.push({ kind: 'usage', ...this.claudeUsage(r.usage) });
    return out;
  }

  codex(value: unknown, rollout = false): TelemetryObservation[] {
    const r = obj(value),
      payload = obj(r.payload),
      item = obj(r.item);
    const out: TelemetryObservation[] = [];
    const model = telemetryName(r.model ?? payload.model);
    if (model) out.push({ kind: 'model', model });
    // exec --json contains tool items, the rollout supplies authoritative usage/model.
    if (
      !rollout &&
      ['item.started', 'item.completed'].includes(String(r.type)) &&
      [
        'command_execution',
        'file_change',
        'mcp_tool_call',
        'web_search',
        'collab_tool_call',
      ].includes(String(item.type)) &&
      typeof item.id === 'string'
    ) {
      out.push({ kind: 'tool_start', id: item.id, name: String(item.type), time: Date.now() });
      if (r.type === 'item.completed')
        out.push({
          kind: 'tool_end',
          id: item.id,
          error:
            item.status === 'failed' ||
            (typeof item.exit_code === 'number' && item.exit_code !== 0),
          time: Date.now(),
        });
    }
    const event = r.type === 'event_msg' ? payload : r;
    const info = obj(event.info);
    if (
      event.type === 'token_count' &&
      hasUsage(info.total_token_usage ?? (!rollout ? info.last_token_usage : undefined))
    ) {
      const total = obj(info.total_token_usage);
      const u = obj(info.total_token_usage ?? info.last_token_usage);
      if (info.total_token_usage) {
        this.codexInput = count(total.input_tokens);
        this.codexOutput = count(total.output_tokens);
        this.codexCache = count(total.cached_input_tokens);
      } else {
        this.codexInput += count(u.input_tokens);
        this.codexOutput += count(u.output_tokens);
        this.codexCache += count(u.cached_input_tokens);
      }
      this.tokenCountSeen = true;
      out.push({
        kind: 'usage',
        input: this.codexInput,
        output: this.codexOutput,
        cacheRead: this.codexCache,
      });
    }
    if (!rollout && r.type === 'turn.completed') {
      if (!this.tokenCountSeen && hasUsage(r.usage)) {
        const u = obj(r.usage);
        this.codexInput += count(u.input_tokens);
        this.codexOutput += count(u.output_tokens);
        this.codexCache += count(u.cached_input_tokens);
        out.push({
          kind: 'usage',
          input: this.codexInput,
          output: this.codexOutput,
          cacheRead: this.codexCache,
        });
      }
      this.tokenCountSeen = false;
    }
    return out;
  }
}
