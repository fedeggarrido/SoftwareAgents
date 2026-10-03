import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import type { AgentSpec } from '../../core/src/agentSpec.js';
import {
  CLAUDE_WEB_TOOLS,
  codexCompilerFlags,
  compileAgent,
  ROLE_PROFILES,
} from '../src/agentCompiler.js';
import { ClaudeCliExecutor } from '../src/executors/claudeCliExecutor.js';
import { CodexCliExecutor } from '../src/executors/codexCliExecutor.js';
import type { ExecutionEvent, ExecutionRequest, Executor } from '../src/executors/executor.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => process.env.HOME ?? actual.homedir()) };
});

/** Prompt-injection battery (SA-064 grows it): one JSON case per attack under fixtures/injection. */
interface InjectionCase {
  id: string;
  task: string;
  threat: string;
  payload: string;
  /** Fixture modes of a CLI that obeys the payload; the executor must stop and fail the run. */
  obeyingCli?: { claude?: string; codex?: string };
}
const directory = path.join(__dirname, 'fixtures/injection');
const cases: InjectionCase[] = fs
  .readdirSync(directory)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')));

function template(role: string): AgentSpec {
  return parse(
    fs.readFileSync(path.join(__dirname, '../../agents/templates', role + '.yaml'), 'utf8'),
  );
}
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'injection-battery-'));
  vi.stubEnv('HOME', root);
  fs.mkdirSync(path.join(root, 'worktree'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
async function run(executor: Executor, attack: InjectionCase) {
  const req: ExecutionRequest = {
    executionId: attack.id,
    projectId: 'project',
    taskKey: attack.task,
    role: 'reviewer',
    prompt: attack.payload,
    flags: [],
    worktreePath: path.join(root, 'worktree'),
    timeoutMin: 1,
    agentSpec: template('reviewer'),
  };
  const events: ExecutionEvent[] = [];
  for await (const event of executor.start(req).events) events.push(event);
  return events.at(-1);
}

it('loads at least the web-exfiltration case', () => {
  expect(cases.map((attack) => attack.id)).toContain('web-exfiltration');
});
for (const attack of cases) {
  it.each(Object.keys(ROLE_PROFILES))(
    `${attack.id}: keeps the payload as data and grants %s no web tool`,
    (role) => {
      const spec = template(role);
      const compiled = compileAgent(spec, role, {
        task: attack.payload,
        repository: attack.payload,
        brainContents: Object.fromEntries(spec.context.brainPaths.map((p) => [p, attack.payload])),
      });
      expect(JSON.parse(compiled.context).task).toBe(attack.payload);
      expect(compiled.systemPrompt).not.toContain(attack.payload);
      expect(compiled.codex.instructions.split('\nUNTRUSTED_CONTEXT_JSON\n')[0]).not.toContain(
        attack.payload,
      );
      expect(compiled.claude.disallowedTools).toEqual(
        expect.arrayContaining([...CLAUDE_WEB_TOOLS]),
      );
      expect(codexCompilerFlags(compiled)).toContain('web_search="disabled"');
    },
  );
  if (attack.obeyingCli?.claude)
    it(`${attack.id}: Claude Executor stops a CLI that obeys the payload`, async () => {
      const executor = new ClaudeCliExecutor({
        binary: process.execPath,
        binaryArgs: [
          path.join(__dirname, 'fixtures/fake-cli.cjs'),
          'claude',
          attack.obeyingCli!.claude!,
        ],
        runtimeDirectory: path.join(root, 'runtime'),
      });
      expect(await run(executor, attack)).toMatchObject({
        type: 'finished',
        exitCode: 1,
        resultSummary: expect.stringMatching(/^Policy violation: /),
      });
    });
  if (attack.obeyingCli?.codex)
    it(`${attack.id}: Codex Executor stops a CLI that obeys the payload`, async () => {
      const executor = new CodexCliExecutor({
        operator: { binaryPaths: { codex: process.execPath } },
        runtimeDirectory: path.join(root, 'runtime'),
        binaryArgs: [path.join(__dirname, 'fixtures/codex-cli.cjs'), attack.obeyingCli!.codex!],
      });
      expect(await run(executor, attack)).toMatchObject({
        type: 'finished',
        exitCode: 1,
        resultSummary: expect.stringMatching(/^Policy violation: /),
      });
    });
}
