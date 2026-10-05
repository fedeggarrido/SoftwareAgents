/**
 * Re-verify the Codex tool surface of the slice profiles against the installed binary
 * (SA-074, SA-QA-4). Run it whenever Codex updates:
 *
 *   npx tsx scripts/verify-codex-tools.ts
 *
 * Two low-effort runs under exactly the flags `codexCompilerFlags()` produces for the Reviewer:
 *  1. The model prints ALL_TOOLS from its code-mode exec tool; the names are read from the rollout
 *     (ground truth), never from the model's prose. Expect zero `mcp__*` tools.
 *  2. A neutral prompt asks for a web search. Expect zero `web_search` events.
 *
 * Spends a little Codex quota. Never pass secrets in the prompts. Exits 1 if either check fails.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse } from 'yaml';

import { codexCompilerFlags, compileAgent } from '../server/src/agentCompiler.js';
import { CODEX_WINDOWS_SANDBOX } from '../server/src/constants.js';
import { resolveCodexBinary } from '../server/src/executors/codexCliExecutor.js';

const root = path.resolve(__dirname, '..');
const spec = parse(fs.readFileSync(path.join(root, 'agents/templates/reviewer.yaml'), 'utf8'));
const flags = codexCompilerFlags(compileAgent(spec, 'reviewer', { task: 'verify-codex-tools' }));
const codex = resolveCodexBinary({});
const sessions = path.join(os.homedir(), '.codex', 'sessions');

function rolloutsSince(since: number): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith('.jsonl') && fs.statSync(file).mtimeMs >= since) files.push(file);
    }
  };
  walk(sessions);
  return files;
}

function run(prompt: string): { records: Record<string, unknown>[]; rollout: string[] } {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-codex-tools-'));
  const since = Date.now() - 1000;
  const result = spawnSync(
    codex,
    [
      'exec',
      '--json',
      ...flags,
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
  const parse = (text: string) =>
    text.split(/\r?\n/).flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  const rollout = rolloutsSince(since).flatMap((file) => [fs.readFileSync(file, 'utf8')]);
  return { records: parse(result.stdout ?? ''), rollout };
}

const version = spawnSync(codex, ['--version'], { encoding: 'utf8' }).stdout.trim();
console.log(`${version} (${codex})`);
console.log(`flags: ${flags.join(' ')}`);

const tools = run(
  'Use your exec tool to run exactly: text(ALL_TOOLS.map(t => t.name).join("\\n")) . ' +
    'Then reply with the output verbatim. Do not call any other tool.',
);
const names = new Set<string>();
for (const text of tools.rollout)
  for (const line of text.split(/\r?\n/)) {
    try {
      const record = JSON.parse(line) as {
        payload?: { type?: string; output?: { text?: string }[] };
      };
      if (record.payload?.type !== 'custom_tool_call_output') continue;
      for (const chunk of record.payload.output ?? [])
        for (const name of (chunk.text ?? '').split(/\r?\n/))
          if (/^[A-Za-z0-9_.-]{3,}$/.test(name.trim())) names.add(name.trim());
    } catch {
      /* not a record */
    }
  }
const mcp = [...names].filter((name) => name.startsWith('mcp__'));
console.log(`tools (${names.size}): ${[...names].sort().join(', ')}`);

const web = run(
  'Use your web search tool to find the title of the GitHub releases page of openai/codex. ' +
    'If you do not have a web search tool, answer exactly NO_WEB_TOOL. Do not run shell commands.',
);
const webEvents = web.records.filter((record) =>
  /^web_search/.test(
    String(
      (record.item as { type?: unknown } | undefined)?.type ??
        (record.payload as { type?: unknown } | undefined)?.type ??
        '',
    ),
  ),
).length;

const ok = names.size > 0 && mcp.length === 0 && webEvents === 0;
console.log(
  `${ok ? 'OK' : 'FAIL'}: ${mcp.length} MCP tools, ${webEvents} web_search events` +
    (names.size === 0 ? ' (no tool list captured: the check is inconclusive)' : ''),
);
process.exitCode = ok ? 0 : 1;
