/**
 * Re-verify the Codex tool surface of the slice profiles against the installed binary
 * (SA-074, SA-QA-4). Run it whenever Codex updates:
 *
 *   npx tsx scripts/verify-codex-tools.ts [--binary <codex.exe>] [--role developer]
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

import { codexCompilerFlags, compileAgent } from '../server/src/agentCompiler.js';
import { CODEX_WINDOWS_SANDBOX } from '../server/src/constants.js';
import { resolveCodexBinary } from '../server/src/executors/codexCliExecutor.js';
import { codexSessionsDirectory } from '../server/src/executors/codexSubagents.js';
import {
  countToolEvents,
  INVENTORY_CODE,
  judgeCodexTools,
} from '../server/src/executors/codexToolVerification.js';

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
// --role developer verifies the workspace-write sandbox; the default Reviewer, read-only.
const roleFlag = process.argv.indexOf('--role');
const role = roleFlag > 0 ? process.argv[roleFlag + 1] : 'reviewer';
const spec = parse(fs.readFileSync(path.join(root, 'agents/templates', `${role}.yaml`), 'utf8'));
const flags = codexCompilerFlags(compileAgent(spec, role, { task: 'verify-codex-tools' }));
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
console.log(`${spawnSync(codex, ['--version'], { encoding: 'utf8' }).stdout.trim()} (${codex})`);
console.log(`flags: ${flags.join(' ')}`);

const tools = run(
  `Use your exec tool to run exactly: ${INVENTORY_CODE} . Then reply with the output verbatim. Do not call any other tool.`,
  [],
  true,
);
const searchPrompt =
  'Use your web search tool to find the title of the GitHub releases page of openai/codex. ' +
  'If you do not have a web search tool, answer exactly NO_WEB_TOOL. Do not run shell commands.';
const web = run(searchPrompt);
const control = run(searchPrompt, ['-c', 'web_search="live"']);
const { inventory, problems, inconclusive, exitCode } = judgeCodexTools(tools, web, control);
console.log(`tools (${inventory.names.length}): ${inventory.names.join(', ')}`);
console.log(
  `web events: compiled ${countToolEvents([...web.stdout, ...web.rollout], 'web')}, live control ${countToolEvents([...control.stdout, ...control.rollout], 'web')}`,
);
if (JSON.stringify(tools.rollout).includes('<multi_agent_role>'))
  console.log('WARN: delegation tools are offered; the Executor fails runs that use them');

if (problems.length) console.log(`FAIL: ${problems.join('; ')}`);
if (inconclusive.length) console.log(`INCONCLUSIVE: ${inconclusive.join('; ')}`);
if (!problems.length && !inconclusive.length) console.log('OK');
process.exitCode = exitCode;
