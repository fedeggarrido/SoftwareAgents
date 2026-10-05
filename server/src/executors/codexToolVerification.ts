import { CODEX_MCP_EVENT_TYPES, CODEX_WEB_EVENT_TYPES } from '../agentCompiler.js';

/** Measured surface on 0.160.0; additions fail and omissions cannot establish completeness. */
export const EXPECTED_TOOLS: ReadonlySet<string> = new Set([
  'apply_patch',
  'clock__curr_time',
  'create_goal',
  'exec_command',
  'get_goal',
  'image_gen__imagegen',
  'update_goal',
  'view_image',
  'write_stdin',
]);
export const INVENTORY_CODE = 'text(ALL_TOOLS.map(t => t.name).join("\\n"))';
export type VerificationRecords = Record<string, unknown>[];
export interface VerificationRun {
  ok: boolean;
  stdout: VerificationRecords;
  rollout: VerificationRecords;
  why?: string;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Inspect structured event types, including nested event envelopes, never prose mentions. */
export function countToolEvents(records: VerificationRecords, kind: 'web' | 'mcp'): number {
  const types = kind === 'web' ? CODEX_WEB_EVENT_TYPES : CODEX_MCP_EVENT_TYPES;
  const contains = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(contains);
    const record = object(value);
    return (
      types.includes(record.type) ||
      [record.payload, record.item].some((v) => v !== null && typeof v === 'object' && contains(v))
    );
  };
  return records.filter(contains).length;
}

/** Only output of the exact requested code-mode exec call is inventory evidence. */
export function inspectInventory(records: VerificationRecords) {
  const calls = new Set<string>();
  const captures: string[][] = [];
  let malformed = false;
  for (const record of records) {
    const payload = object(record.payload);
    if (
      payload.type === 'custom_tool_call' &&
      (payload.name === 'exec' || payload.name === 'functions.exec') &&
      typeof payload.input === 'string' &&
      payload.input.trim() === INVENTORY_CODE &&
      typeof payload.call_id === 'string'
    )
      calls.add(payload.call_id);
    if (
      payload.type !== 'custom_tool_call_output' ||
      typeof payload.call_id !== 'string' ||
      !calls.has(payload.call_id)
    )
      continue;
    const chunks = Array.isArray(payload.output) ? payload.output : [];
    const text = chunks
      .map((chunk) => object(chunk).text)
      .filter((v): v is string => typeof v === 'string')
      .join('\n');
    const names = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!names.length || names.some((name) => !/^[A-Za-z0-9_.-]+$/.test(name))) malformed = true;
    captures.push(names.filter((name) => /^[A-Za-z0-9_.-]+$/.test(name)));
  }
  const names = [...new Set(captures.flat())].sort();
  const extra = names.filter((name) => !EXPECTED_TOOLS.has(name));
  const complete =
    !malformed &&
    captures.some((capture) => [...EXPECTED_TOOLS].every((name) => capture.includes(name)));
  return { names, extra, complete };
}

/** Pure verdict over all three own rollouts plus stdout. A failure takes priority over uncertainty. */
export function judgeCodexTools(
  tools: VerificationRun,
  web: VerificationRun,
  control: VerificationRun,
) {
  const problems: string[] = [];
  const inconclusive: string[] = [];
  const inventory = inspectInventory(tools.rollout);
  if (inventory.extra.length) problems.push(`unexpected tools: ${inventory.extra.join(', ')}`);
  if (!inventory.complete)
    inconclusive.push('tool listing: no complete correlated ALL_TOOLS inventory');
  for (const [label, run] of [
    ['tools', tools],
    ['web', web],
    ['control', control],
  ] as const) {
    if (!run.ok) inconclusive.push(`${label} run: ${run.why ?? 'incomplete execution'}`);
    const mcp = countToolEvents([...run.stdout, ...run.rollout], 'mcp');
    if (mcp) problems.push(`${label}: ${mcp} MCP events`);
    const rolloutText = JSON.stringify(run.rollout);
    if (
      rolloutText.includes('CANARY_AGENTS_MD') ||
      rolloutText.includes('# AGENTS.md instructions')
    )
      problems.push(`${label}: the workdir AGENTS.md was injected`);
    if (label !== 'control' && countToolEvents([...run.stdout, ...run.rollout], 'web'))
      problems.push(`${label}: web events under the compiled flags`);
  }
  if (!countToolEvents([...control.stdout, ...control.rollout], 'web'))
    inconclusive.push('live control produced no web event: the web check proves nothing');
  return {
    inventory,
    problems,
    inconclusive,
    exitCode: problems.length ? 1 : inconclusive.length ? 2 : 0,
  };
}
