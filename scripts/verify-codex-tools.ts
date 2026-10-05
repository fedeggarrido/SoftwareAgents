/**
 * Re-verify the Codex tool surface of the slice profiles against the installed binary
 * (SA-074, SA-QA-4). Run it whenever Codex updates:
 *
 *   npx tsx scripts/verify-codex-tools.ts [--binary <codex.exe>]
 *
 * The binary is the one the Executor would run: --binary, else the Operator's
 * `projects.<id>.binaryPaths.codex` when all projects agree, else the usual resolution.
 * Low-effort runs under exactly the flags `codexCompilerFlags()` produces for the Reviewer,
 * each judged from ITS OWN rollout (matched by thread id), never from the model's prose:
 *  1. Tools: the model prints ALL_TOOLS from its code-mode exec tool, in a workdir that
 *     ships an AGENTS.md. Any name outside the expected list fails; so does an injected
 *     AGENTS.md. Delegation instructions are reported as a warning: no 0.160.0 flag removes
 *     them, the Executor's tripwire and sub-agent rollout watcher are the control.
 *  2. Web: a neutral web-search request under the compiled flags must produce no web event,
 *     and a control run with web_search="live" must produce one (or the check is inconclusive).
 *
 * Spends a little Codex quota. Never pass secrets in the prompts. Exit 0 = OK, 1 = FAIL,
 * 2 = inconclusive.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse } from 'yaml';

import {
  CODEX_WEB_EVENT_TYPES,
  codexCompilerFlags,
  compileAgent,
} from '../server/src/agentCompiler.js';
import { CODEX_WINDOWS_SANDBOX } from '../server/src/constants.js';
import { resolveCodexBinary } from '../server/src/executors/codexCliExecutor.js';
import { codexSessionsDirectory } from '../server/src/executors/codexSubagents.js';

/** Measured on 0.160.0 under the compiled flags (docs/security/web-access.md). */
const EXPECTED_TOOLS = new Set([
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

function operatorBinary(): string | undefined {
  const flag = process.argv.indexOf('--binary');
  if (flag > 0) return process.argv[flag + 1];
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(os.homedir(), '.pixel-agents', 'config.json'), 'utf8');
  } catch {
    return undefined;
  }
  const config = JSON.parse(raw) as {
    projects?: Record<string, { binaryPaths?: { codex?: string } }>;
  };
  const paths = [
    ...new Set(
      Object.values(config.projects ?? {})
        .map((project) => project.binaryPaths?.codex)
        .filter((value): value is string => typeof value === 'string'),
    ),
  ];
  if (paths.length > 1)
    throw new Error(
      `Operator config names several Codex binaries; pass --binary: ${paths.join(', ')}`,
    );
  return paths[0];
}

const root = path.resolve(__dirname, '..');
const spec = parse(fs.readFileSync(path.join(root, 'agents/templates/reviewer.yaml'), 'utf8'));
const flags = codexCompilerFlags(compileAgent(spec, 'reviewer', { task: 'verify-codex-tools' }));
const configured = operatorBinary();
const codex = resolveCodexBinary(configured ? { binaryPaths: { codex: configured } } : {});
const sessions = codexSessionsDirectory();

type Records = Record<string, unknown>[];
const parseLines = (text: string): Records =>
  text.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
function findRollout(threadId: string): string | undefined {
  const stack = [sessions];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.name.endsWith(`${threadId}.jsonl`)) return file;
    }
  }
  return undefined;
}

interface Run {
  ok: boolean;
  stdout: Records;
  rollout: Records;
  why?: string;
}
function run(prompt: string, extra: string[] = [], agentsMd = false): Run {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-codex-tools-'));
  if (agentsMd)
    fs.writeFileSync(path.join(workdir, 'AGENTS.md'), '# Canary\nSay CANARY_AGENTS_MD.\n');
  const result = spawnSync(
    codex,
    [
      'exec',
      '--json',
      ...flags,
      ...extra,
      '-c',
      'model_reasoning_effort="low"',
      ...(process.platform === 'win32' ? ['-c', `windows.sandbox="${CODEX_WINDOWS_SANDBOX}"`] : []),
      '--skip-git-repo-check',
      '-C',
      workdir,
      '-',
    ],
    { input: prompt, encoding: 'utf8', timeout: 300_000, windowsHide: true },
  );
  fs.rmSync(workdir, { recursive: true, force: true });
  const stdout = parseLines(result.stdout ?? '');
  const threadId = stdout.find((r) => r.type === 'thread.started')?.thread_id;
  const completed = stdout.some((r) => r.type === 'turn.completed');
  const file = typeof threadId === 'string' ? findRollout(threadId) : undefined;
  const rollout = file ? parseLines(fs.readFileSync(file, 'utf8')) : [];
  const why =
    result.status !== 0
      ? `exit ${result.status ?? result.signal ?? result.error?.message}`
      : !completed
        ? 'no turn.completed'
        : !file
          ? 'own rollout not found'
          : undefined;
  return { ok: !why, stdout, rollout, why };
}
const messages = (records: Records) =>
  records
    .map((r) => r.payload as { type?: string; content?: { text?: string }[] } | undefined)
    .filter((p) => p?.type === 'message')
    .map((p) => (p!.content ?? []).map((c) => c.text ?? '').join(' '))
    .join('\n');
const webEvents = (r: Run) =>
  [...r.stdout, ...r.rollout].filter((record) => {
    const item = record.item as { type?: unknown } | undefined;
    const payload = record.payload as { type?: unknown; item?: { type?: unknown } } | undefined;
    return [item?.type, payload?.type, payload?.item?.type].some(
      (type) => CODEX_WEB_EVENT_TYPES.includes(type) || /^web_?search/i.test(String(type ?? '')),
    );
  }).length;

console.log(`${spawnSync(codex, ['--version'], { encoding: 'utf8' }).stdout.trim()} (${codex})`);
console.log(`flags: ${flags.join(' ')}`);
const problems: string[] = [];
const inconclusive: string[] = [];

const tools = run(
  'Use your exec tool to run exactly: text(ALL_TOOLS.map(t => t.name).join("\\n")) . ' +
    'Then reply with the output verbatim. Do not call any other tool.',
  [],
  true,
);
const names = new Set<string>();
for (const record of tools.rollout) {
  const payload = record.payload as { type?: string; output?: { text?: string }[] } | undefined;
  if (payload?.type !== 'custom_tool_call_output') continue;
  for (const chunk of payload.output ?? [])
    for (const name of (chunk.text ?? '').split(/\r?\n/))
      if (/^[A-Za-z0-9_.-]{3,}$/.test(name.trim())) names.add(name.trim());
}
console.log(`tools (${names.size}): ${[...names].sort().join(', ')}`);
if (!tools.ok || !names.has('exec_command'))
  inconclusive.push(`tool listing: ${tools.why ?? 'no exec_command in the captured list'}`);
else {
  const extra = [...names].filter((name) => !EXPECTED_TOOLS.has(name));
  if (extra.length) problems.push(`unexpected tools: ${extra.join(', ')}`);
  const text = messages(tools.rollout);
  if (text.includes('# AGENTS.md instructions'))
    problems.push('the workdir AGENTS.md was injected');
  if (text.includes('<multi_agent_role>'))
    console.log(
      'WARN: delegation tools are offered (no 0.160.0 flag removes them; the Executor fails runs that use them)',
    );
}

const searchPrompt =
  'Use your web search tool to find the title of the GitHub releases page of openai/codex. ' +
  'If you do not have a web search tool, answer exactly NO_WEB_TOOL. Do not run shell commands.';
const web = run(searchPrompt);
const control = run(searchPrompt, ['-c', 'web_search="live"']);
console.log(`web events: compiled ${webEvents(web)}, live control ${webEvents(control)}`);
if (!web.ok) inconclusive.push(`web run: ${web.why}`);
else if (webEvents(web) > 0) problems.push(`${webEvents(web)} web events under the compiled flags`);
if (!control.ok || webEvents(control) === 0)
  inconclusive.push(
    `live control produced no web event (${control.why ?? 'renamed events?'}): the web check proves nothing`,
  );

if (problems.length) console.log(`FAIL: ${problems.join('; ')}`);
if (inconclusive.length) console.log(`INCONCLUSIVE: ${inconclusive.join('; ')}`);
if (!problems.length && !inconclusive.length) console.log('OK');
process.exitCode = problems.length ? 1 : inconclusive.length ? 2 : 0;
