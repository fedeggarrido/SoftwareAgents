import * as fs from 'fs';
import { createInterface } from 'readline';

import type { TelemetryConfig } from '../../core/src/project.js';
import { gitCommonDir } from './boardWatcher.js';
import { CliUsageError } from './cliErrors.js';
import { TELEMETRY_FILE_BYTES, TELEMETRY_PRICE_TOKENS } from './constants.js';
import { resolveInside } from './pathGuard.js';
import { loadProjectConfig } from './projectConfig.js';
import { telemetryDirectory, type TelemetrySpan } from './telemetry.js';

type Unknown = 'unknown';
export interface TelemetryTotals {
  executions: number;
  inputTokens: number | Unknown;
  outputTokens: number | Unknown;
  cacheReadTokens: number | Unknown;
  cacheCreateTokens: number | Unknown;
  cacheHitRate: number | Unknown;
  costUsd: number | Unknown;
  phasesMs: { preparation: number; execution: number; commit_guards: number };
}
export function emptyTelemetryTotals(): TelemetryTotals {
  return {
    executions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    cacheHitRate: 'unknown',
    costUsd: 0,
    phasesMs: { preparation: 0, execution: 0, commit_guards: 0 },
  };
}
export function telemetryAttributes(span: TelemetrySpan): Record<string, string | number> {
  return Object.fromEntries(
    span.attributes.map(({ key, value }) => [
      key,
      'intValue' in value ? Number(value.intValue) : value.stringValue,
    ]),
  );
}
export function addTelemetryTotals(
  total: TelemetryTotals,
  a: Record<string, string | number>,
  prices?: TelemetryConfig['prices'],
) {
  total.executions++;
  const number = (key: string): number | Unknown =>
    typeof a[key] === 'number' && Number.isFinite(a[key]) && a[key] >= 0 ? a[key] : 'unknown';
  const input = number('gen_ai.usage.input_tokens');
  const output = number('gen_ai.usage.output_tokens');
  const read = number('gen_ai.usage.cache_read.input_tokens');
  // Codex has no cache creation counter; do not fabricate one.
  const create = number('gen_ai.usage.cache_creation.input_tokens');
  const sum = (x: number | Unknown, y: number | Unknown) =>
    x === 'unknown' || y === 'unknown' ? 'unknown' : x + y;
  total.inputTokens = sum(total.inputTokens, input);
  total.outputTokens = sum(total.outputTokens, output);
  total.cacheReadTokens = sum(total.cacheReadTokens, read);
  total.cacheCreateTokens = sum(total.cacheCreateTokens, create);
  total.cacheHitRate =
    typeof total.inputTokens === 'number' &&
    total.inputTokens > 0 &&
    typeof total.cacheReadTokens === 'number'
      ? total.cacheReadTokens / total.inputTokens
      : 'unknown';
  for (const phase of ['preparation', 'execution', 'commit_guards'] as const) {
    const time = number(`softwareagents.phase.${phase}_ms`);
    if (time !== 'unknown') total.phasesMs[phase] += time;
  }
  const model = a['gen_ai.response.model'];
  const price =
    typeof model === 'string' && Object.hasOwn(prices ?? {}, model) ? prices![model] : undefined;
  // Unknown response model/usage/prices or a multi-model run cannot yield a reliable cost.
  const created = create === 'unknown' && a['softwareagents.executor'] === 'codex' ? 0 : create;
  let cost: number | Unknown = 'unknown';
  if (
    price &&
    a['softwareagents.model.multiple'] !== 1 &&
    typeof input === 'number' &&
    typeof output === 'number' &&
    typeof read === 'number' &&
    typeof created === 'number' &&
    input >= read + created &&
    (read === 0 || price.cacheRead !== undefined) &&
    (created === 0 || price.cacheCreate !== undefined)
  )
    cost =
      ((input - read - created) * price.input +
        output * price.output +
        read * (price.cacheRead ?? 0) +
        created * (price.cacheCreate ?? 0)) /
      TELEMETRY_PRICE_TOKENS;
  total.costUsd = sum(total.costUsd, cost);
}

/** Read only, bounded to the two retained files. No quota probes, CLI or worker launches. */
export async function telemetrySummary(
  common: string,
  project: string,
  task?: string,
  prices?: TelemetryConfig['prices'],
) {
  const dir = telemetryDirectory(common, project);
  const total = emptyTelemetryTotals();
  const byTask: Record<string, TelemetryTotals> = Object.create(null);
  const byExecutorLevel: Record<string, TelemetryTotals> = Object.create(null);
  let invalidLines = 0;
  const seen = new Set<string>();
  if (!fs.existsSync(dir)) {
    total.costUsd = 'unknown';
    return { retainedHistoryOnly: true, invalidLines, total, byTask, byExecutorLevel };
  }
  for (const name of ['spans.1.jsonl', 'spans.jsonl']) {
    const file = resolveInside(dir, name);
    if (!fs.existsSync(file)) continue;
    const input = fs.createReadStream(file, { end: TELEMETRY_FILE_BYTES - 1 });
    // A concurrent rotation may remove the file between the check and the read: partial view.
    const lines = (async function* () {
      try {
        yield* createInterface({ input });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    })();
    for await (const line of lines) {
      try {
        const record = JSON.parse(line);
        const span = record.resourceSpans[0].scopeSpans[0].spans[0] as TelemetrySpan;
        if (span.name !== 'invoke_agent') continue;
        const a = telemetryAttributes(span);
        const key = a['softwareagents.task.key'];
        if (typeof key !== 'string' || (task && key !== task)) continue;
        if (seen.has(span.spanId)) continue;
        seen.add(span.spanId);
        const group = `${a['softwareagents.executor'] ?? 'unknown'}/${a['softwareagents.model.tier'] ?? 'unknown'}`;
        addTelemetryTotals(total, a, prices);
        addTelemetryTotals((byTask[key] ??= emptyTelemetryTotals()), a, prices);
        addTelemetryTotals((byExecutorLevel[group] ??= emptyTelemetryTotals()), a, prices);
      } catch {
        invalidLines++;
      }
    }
  }
  if (!total.executions) total.costUsd = 'unknown';
  return { retainedHistoryOnly: true, invalidLines, total, byTask, byExecutorLevel };
}

export async function runTelemetryCommand(
  argv: string[],
  cwd = process.cwd(),
  log = console.log,
): Promise<void> {
  if (argv[0] !== 'summary')
    throw new CliUsageError('Usage: pixel-agents telemetry summary [--task KEY] --json');
  let task: string | undefined;
  let json = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--json' && !json) json = true;
    else if (argv[i] === '--task' && !task && /^SA-\d{3,}$/.test(argv[i + 1] ?? ''))
      task = argv[++i];
    else throw new CliUsageError('Expected unique --task SA-### and --json');
  }
  const config = loadProjectConfig(cwd, true);
  const common = gitCommonDir(cwd);
  if (!config || !common) throw new CliUsageError('telemetry summary requires a bound Git Project');
  log(
    JSON.stringify(
      await telemetrySummary(common, config.project.id, task, config.operator.telemetry?.prices),
      null,
      2,
    ),
  );
}
