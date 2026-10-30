import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import type { AutonomyLevel } from '../../core/src/project.js';
import { AuditLog } from '../src/auditLog.js';
import {
  claudeToolContainment,
  codexItemContainment,
  commandContainment,
  containmentDecision,
  type ContainmentRule,
  pathContainment,
} from '../src/executors/agentContainment.js';
import { ClaudeCliExecutor } from '../src/executors/claudeCliExecutor.js';
import { CodexCliExecutor } from '../src/executors/codexCliExecutor.js';
import type { ExecutionEvent, ExecutionRequest } from '../src/executors/executor.js';
import { getHookScriptPath } from '../src/providers/hook/claude/claudeHookInstaller.js';
import { removeTempDir } from './helpers/removeTempDir.js';

vi.setConfig({ testTimeout: 300_000 });

it.each(['Set-Content test.ts ".git"', 'Set-Content ../outside.ts text'])(
  'returns actionable shell containment diagnostics: %s',
  (command) => {
    const verdict = claudeToolContainment('PowerShell', { command }, worktree);
    expect(verdict).toMatchObject({ allowed: false });
    if (verdict.allowed) throw new Error('Expected denial');
    expect(verdict.reason).toContain(verdict.rule);
    expect(verdict.reason).toContain(command.includes('.git') ? '.git' : '../outside.ts');
    expect(verdict.reason).toContain('usa apply_patch/Edit para escribir ficheros');
    expect(codexItemContainment({ type: 'command_execution', command }, worktree)).toEqual(verdict);
  },
);

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => process.env.HOME ?? actual.homedir()) };
});

// Match the executor suites: sandbox fixtures self-close when native taskkill is unavailable.
// Failed termination and retries are tested with simulated processes in executorTermination.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: (file: string, ...args: unknown[]) => {
      if (file === 'taskkill' && process.env.SA_SKIP_TASKKILL_TEST === '1') return Buffer.alloc(0);
      return Reflect.apply(actual.execFileSync, actual, [file, ...args]);
    },
  };
});

// Built by `npm run build:extension` (CI builds before server tests, like claude-hook.test.ts).
const HOOK_SCRIPT = path.join(__dirname, '../../dist/hooks/containment-hook.js');

let root: string;
let worktree: string;
let req: ExecutionRequest;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'containment-'));
  vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('USERPROFILE', path.join(root, 'home'));
  worktree = path.join(root, 'worktree');
  fs.mkdirSync(worktree);
  req = {
    executionId: 'run-1',
    projectId: 'project',
    taskKey: 'SA-062',
    role: 'developer',
    prompt: 'fake',
    flags: [],
    worktreePath: worktree,
    timeoutMin: 1,
  };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await removeTempDir(root);
}, 30_000);

const denials = () =>
  new AuditLog()
    .read('project')
    .flatMap((line) => (line.corrupt ? [] : [line.entry]))
    .filter((entry) => entry.action === 'agent_containment');

describe('commandContainment', () => {
  it.each<[string, ContainmentRule]>([
    ['git push origin HEAD:main', 'git_push'],
    ['git -C ../other --no-pager push', 'git_push'],
    ['env GIT_TRACE=1 git push', 'git_push'],
    [`"git" 'push' origin`, 'git_push'],
    ["/bin/bash -lc 'cd x && git push origin HEAD'", 'git_push'],
    ['npm test; /usr/bin/git push', 'git_push'],
    ['"C:\\Program Files\\Git\\cmd\\git.exe" push', 'git_push'],
    ['GIT.EXE PUSH', 'git_push'],
    ['g\\it push', 'git_push'],
    ['git send-pack ../bare HEAD', 'git_push'],
    ['echo $(git push)', 'git_push'],
    ['git config --worktree remote.origin.pushurl https://example.invalid', 'git_config'],
    ['git config --get user.name', 'git_config'],
    ['p=push; git $p origin x', 'unparseable'],
    ['git ${p} origin x', 'unparseable'],
    ['git $(printf push) origin x', 'unparseable'],
    ['git `printf push` origin x', 'unparseable'],
    ['git %VERB% origin x', 'unparseable'],
    ['(git $verb origin x)', 'unparseable'],
    ['echo $(git $verb origin x)', 'unparseable'],
    ['git -C "$repo" --no-pager $verb origin x', 'unparseable'],
    ['git -c alias.ship=push ship origin', 'git_config'],
    ['git -calias.ship=push ship origin', 'git_config'],
    ['git -c core.quotePath=false -c alias.ship="!git push" ship origin', 'git_config'],
    ['git --config-env=alias.ship=ALIAS ship origin', 'git_config'],
    ['git remote add evil https://example.invalid/r.git', 'git_remote'],
    ['gh pr create --fill', 'gh'],
    ['C:\\tools\\gh.exe auth token', 'gh'],
  ])('denies %s', (command, rule) => {
    expect(commandContainment(command)).toMatchObject({ allowed: false, rule });
  });
  it.each([
    'git status',
    'git diff -- server/config.ts',
    'git log --grep=push',
    'git -C "$repo" status',
    'git -c core.quotePath=false diff',
    'git --git-dir="$dir" status',
    'git diff -- "$file"',
    'git log --format="$format"',
    'npm test && echo push',
    'cat .github/remote.md',
  ])('allows %s', (command) => {
    expect(commandContainment(command)).toEqual({ allowed: true });
  });
});

describe('pathContainment', () => {
  it.each<[string, ContainmentRule]>([
    ['.claude/settings.json', 'protected_write'],
    ['.claude/hooks/x.sh', 'protected_write'],
    ['.git/config', 'protected_write'],
    ['.git', 'protected_write'],
    ['.GIT/hooks/pre-commit', 'protected_write'],
    ['.claude./settings.json', 'protected_write'],
    ['.git::$INDEX_ALLOCATION/config', 'protected_write'],
    ['packages/app/.git/config', 'protected_write'],
    ['sub/.gitconfig', 'protected_write'],
    ['../escape.ts', 'outside_worktree'],
    [path.join(os.tmpdir(), 'elsewhere.ts'), 'outside_worktree'],
  ])('denies %s', (file, rule) => {
    expect(pathContainment(file, worktree)).toMatchObject({ allowed: false, rule });
  });
  it('allows ordinary worktree files, relative or absolute', () => {
    expect(pathContainment('src/index.ts', worktree)).toEqual({ allowed: true });
    expect(pathContainment(path.join(worktree, 'README.md'), worktree)).toEqual({ allowed: true });
    expect(pathContainment('.github-notes.md', worktree)).toEqual({ allowed: true });
  });
  it.skipIf(process.platform === 'win32')('judges a symlink by where the write lands', () => {
    fs.mkdirSync(path.join(worktree, '.git'));
    fs.symlinkSync(path.join(worktree, '.git'), path.join(worktree, 'innocent'));
    fs.symlinkSync(os.tmpdir(), path.join(worktree, 'tmp-link'));
    expect(pathContainment('innocent/config', worktree)).toMatchObject({
      allowed: false,
      rule: 'protected_write',
    });
    expect(pathContainment('tmp-link/x.ts', worktree)).toMatchObject({
      allowed: false,
      rule: 'outside_worktree',
    });
  });
});

describe('tool adapters', () => {
  it.each([
    'echo x > .claude/settings.json',
    'echo x >> .claude/settings.json',
    'Set-Content .CLAUDE\\settings.json x',
    'Add-Content -LiteralPath .claude/settings.json x',
    '"x" | Out-File -FilePath .claude/settings.json',
    'echo x | tee .claude/settings.json',
    'cp source .claude/settings.json',
    'mv source .claude/settings.json',
    'copy source .claude\\settings.json',
    'move source .claude\\settings.json',
    'Copy-Item source -Destination .claude/settings.json',
    'Move-Item source -Destination .claude/settings.json',
    `node -e "require('fs').writeFileSync('.claude/x', 'TEST_SECRET')"`,
    `python -c "open('.claude/x', 'w').write('TEST_SECRET')"`,
    `python3 -c "from pathlib import Path; Path('.claude/x').write_text('x')"`,
    'echo x > .git/config',
    'Set-Content .gitconfig x',
    'echo x > .claude./settings.json',
    'echo x > C:/outside/.claude/settings.json',
    'Set-Content /outside/.CLAUDE/settings.json x',
  ])('denies evident protected shell writes: %s', (command) => {
    expect(codexItemContainment({ type: 'command_execution', command }, worktree)).toMatchObject({
      allowed: false,
      rule: 'protected_write',
    });
    expect(claudeToolContainment('Bash', { command }, worktree)).toMatchObject({
      allowed: false,
      rule: 'protected_write',
    });
  });
  it.each([
    'cat .claude/settings.json',
    'Get-Content .CLAUDE\\settings.json',
    'echo x > src/a.ts',
    'Set-Content src/a.ts x',
    'cp source src/a.ts',
    `node -e "require('fs').readFileSync('.claude/x')"`,
    `node -e "require('fs').writeFileSync('src/a.ts', 'x')"`,
  ])('allows ordinary shell writes and protected reads: %s', (command) => {
    expect(codexItemContainment({ type: 'command_execution', command }, worktree)).toEqual({
      allowed: true,
    });
  });
  it('checks argv commands and protected file_change paths', () => {
    expect(
      codexItemContainment(
        {
          type: 'command_execution',
          command: ['powershell', '-Command', 'Set-Content .CLAUDE\\x x'],
        },
        worktree,
      ),
    ).toMatchObject({ rule: 'protected_write' });
    expect(
      codexItemContainment(
        { type: 'file_change', changes: [{ path: 'src/a.ts' }, { path: '.CLAUDE/settings.json' }] },
        worktree,
      ),
    ).toMatchObject({ rule: 'protected_write' });
  });
  it('maps Claude shell and write tools, and denies malformed inputs', () => {
    expect(claudeToolContainment('Bash', { command: 'git push' }, worktree)).toMatchObject({
      rule: 'git_push',
    });
    expect(
      claudeToolContainment('Write', { file_path: '.claude/settings.json' }, worktree),
    ).toMatchObject({ rule: 'protected_write' });
    expect(
      claudeToolContainment('NotebookEdit', { notebook_path: '.git/x.ipynb' }, worktree),
    ).toMatchObject({ rule: 'protected_write' });
    expect(claudeToolContainment('Edit', {}, worktree)).toMatchObject({ rule: 'unparseable' });
    expect(claudeToolContainment('Bash', null, worktree)).toMatchObject({ rule: 'unparseable' });
    expect(claudeToolContainment('Read', { file_path: '.git/config' }, worktree)).toEqual({
      allowed: true,
    });
  });
  it('maps Codex command and patch items', () => {
    expect(
      codexItemContainment({ type: 'command_execution', command: 'git remote -v' }, worktree),
    ).toMatchObject({ rule: 'git_remote' });
    expect(
      codexItemContainment(
        { type: 'file_change', changes: [{ path: path.join(worktree, '.git/config') }] },
        worktree,
      ),
    ).toMatchObject({ rule: 'protected_write' });
    expect(
      codexItemContainment({ type: 'command_execution', command: 'git diff' }, worktree),
    ).toEqual({ allowed: true });
    expect(codexItemContainment({ type: 'agent_message', text: 'git push' }, worktree)).toEqual({
      allowed: true,
    });
  });
});

describe('containmentDecision', () => {
  const rules: ContainmentRule[] = [
    'git_push',
    'git_config',
    'git_remote',
    'gh',
    'protected_write',
    'outside_worktree',
    'unparseable',
  ];
  it.each(rules)('never allows %s, whatever the policy table says', (rule) => {
    expect(containmentDecision(rule).outcome).not.toBe('allow');
    expect(containmentDecision(rule).reason).toBeTruthy();
  });
  it('is level-independent for agents in policy.ts', async () => {
    const { evaluatePolicy } = await import('../src/policy.js');
    for (const level of ['A0', 'A1', 'A2', 'A3', 'A4'] as AutonomyLevel[]) {
      expect(evaluatePolicy('bypass_permissions', 'agent', level).outcome).toBe('deny');
      expect(evaluatePolicy('touch_protected_path', 'agent', level).outcome).toBe('require_human');
    }
  });
});

describe('containment hook script', () => {
  const context = () => {
    const file = path.join(root, 'containment.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        worktreeRoot: worktree,
        projectId: 'project',
        taskKey: 'SA-062',
        executionId: 'run-1',
        executor: 'claude',
      }),
    );
    return file;
  };
  const run = (input: string, args = [context()]) =>
    spawnSync(process.execPath, [HOOK_SCRIPT, ...args], {
      input,
      encoding: 'utf8',
      env: { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home') },
    });
  const preToolUse = (tool_name: string, tool_input: unknown) =>
    JSON.stringify({ hook_event_name: 'PreToolUse', cwd: worktree, tool_name, tool_input });

  it('denies an injected git push origin HEAD:main and audits it without the command', () => {
    const secret = 'https://user:TEST_SECRET@github.com/o/r.git';
    const result = run(preToolUse('Bash', { command: `git push ${secret} HEAD:main` }));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('git push is reserved to the runtime');
    const [entry] = denials();
    expect(entry).toMatchObject({
      actorType: 'agent',
      actorId: 'claude',
      resourceId: 'Bash',
      taskKey: 'SA-062',
      executionId: 'run-1',
      riskLevel: 'high',
      policyDecision: { outcome: 'deny' },
      outcome: { status: 'denied', detail: 'git_push' },
    });
    expect(JSON.stringify(new AuditLog().read('project'))).not.toContain('TEST_SECRET');
  });
  it('denies a .claude write and allows ordinary work without audit noise', () => {
    expect(run(preToolUse('Write', { file_path: '.claude/settings.json' })).status).toBe(2);
    expect(run(preToolUse('Write', { file_path: 'src/a.ts' })).status).toBe(0);
    expect(run(preToolUse('Bash', { command: 'git status' })).status).toBe(0);
    expect(denials().map((entry) => entry.outcome.detail)).toEqual(['protected_write']);
  });
  it.each([
    ['unparseable input', 'not json', undefined],
    ['missing context', preToolUse('Write', { file_path: 'src/a.ts' }), []],
    ['unreadable context', preToolUse('Write', { file_path: 'src/a.ts' }), ['/nonexistent.json']],
  ])('fails closed on %s', (_name, input, args) => {
    expect(run(input, args).status).toBe(2);
  });
  it.each(['not json TEST_SECRET', 'null', '[]'])(
    'audits malformed stdin with a readable context: %s',
    (input) => {
      const result = run(input);
      expect(result.status).toBe(2);
      expect(denials()).toEqual([
        expect.objectContaining({
          resourceId: 'unknown',
          executionId: 'run-1',
          outcome: expect.objectContaining({ detail: 'unparseable' }),
        }),
      ]);
      expect(JSON.stringify(denials())).not.toContain('TEST_SECRET');
    },
  );
});

describe('executors', () => {
  function claude(mode: string) {
    const officeLog = path.join(root, 'office-hook.log');
    const officeHook = path.join(root, 'office-hook.cjs');
    fs.writeFileSync(
      officeHook,
      `require('fs').appendFileSync(${JSON.stringify(officeLog)}, require('fs').readFileSync(0, 'utf8') + '\\n');`,
    );
    fs.mkdirSync(path.dirname(getHookScriptPath()), { recursive: true });
    fs.writeFileSync(getHookScriptPath(), '');
    return {
      officeLog,
      executor: new ClaudeCliExecutor({
        binary: process.execPath,
        binaryArgs: [path.join(__dirname, 'fixtures/fake-cli.cjs'), 'claude', mode],
        runtimeDirectory: path.join(root, 'runtime'),
        hookCommand: `"${process.execPath}" "${officeHook}"`,
        containmentHookScript: HOOK_SCRIPT,
      }),
    };
  }
  async function drain(events: AsyncIterable<ExecutionEvent>) {
    const all: ExecutionEvent[] = [];
    for await (const event of events) all.push(event);
    return all;
  }

  it('Claude: the runtime --settings hook denies and audits an injected push; office hooks still fire', async () => {
    const { executor, officeLog } = claude('--containment-push');
    const events = await drain(executor.start(req).events);
    expect(events).toContainEqual({
      type: 'output',
      stream: 'stdout',
      text: 'Containment: Bash denied (git_push)',
    });
    expect(events.some((event) => event.type === 'toolUse')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'finished', exitCode: 0, resultSummary: 'Push denied' });
    expect(denials()).toEqual([
      expect.objectContaining({
        executionId: 'run-1',
        outcome: expect.objectContaining({ detail: 'git_push' }),
      }),
    ]);
    expect(fs.readFileSync(officeLog, 'utf8')).toContain('"tool_name":"Bash"');
  });
  it('Claude: a contained tool that still ran (hook failed open) fails the run and is audited', async () => {
    const events = await drain(claude('--containment-failopen').executor.start(req).events);
    expect(events.at(-1)).toMatchObject({
      type: 'finished',
      exitCode: 1,
      resultSummary: 'Policy violation: Claude ran Bash despite agent containment (git_push)',
    });
    // One entry from the hook (it did deny) and one from the executor tripwire.
    expect(denials()).toHaveLength(2);
  });
  it('Claude continues after an actionable shell-write denial from the hook', async () => {
    const events = await drain(claude('--containment-shell').executor.start(req).events);
    expect(events.at(-1)).toMatchObject({ type: 'finished', exitCode: 0 });
    expect(denials()[0].outcome).toMatchObject({
      detail: 'protected_write',
      reason: expect.stringContaining('usa apply_patch/Edit'),
    });
    expect(events.some((event) => event.type === 'guardCorrection')).toBe(false);
  });
  it.each(['--containment-no-result', '--containment-partial-results'])(
    'Claude: %s fails and audits every unresolved attempt at EOF',
    async (mode) => {
      const events = await drain(claude(mode).executor.start(req).events);
      expect(events.at(-1)).toMatchObject({
        type: 'finished',
        exitCode: 1,
        resultSummary: expect.stringContaining('without a tool_result'),
      });
      expect(denials().map((entry) => entry.outcome.detail)).toEqual(
        mode === '--containment-no-result' ? ['git_push', 'protected_write'] : ['protected_write'],
      );
      expect(JSON.stringify(denials())).not.toContain('TEST_SECRET');
      expect(events.some((event) => event.type === 'toolUse')).toBe(false);
    },
  );
  it('Claude: refuses to launch without the built containment hook', async () => {
    const executor = new ClaudeCliExecutor({
      binary: process.execPath,
      binaryArgs: [path.join(__dirname, 'fixtures/fake-cli.cjs'), 'claude'],
      runtimeDirectory: path.join(root, 'runtime'),
      containmentHookScript: path.join(root, 'absent.js'),
    });
    expect((await drain(executor.start(req).events)).at(-1)).toMatchObject({
      type: 'finished',
      exitCode: 1,
      resultSummary: expect.stringContaining('Containment hook is not built'),
    });
  });
  it.each<[string, ContainmentRule]>([
    ['--git-push', 'git_push'],
    ['--claude-write', 'protected_write'],
    ['--claude-shell-write', 'protected_write'],
    ['--git-dynamic', 'unparseable'],
    ['--git-alias', 'git_config'],
  ])('Codex: %s stops the run and is audited once', async (mode, rule) => {
    const executor = new CodexCliExecutor({
      operator: { binaryPaths: { codex: process.execPath } },
      runtimeDirectory: path.join(root, 'runtime'),
      sessionsDirectory: path.join(root, 'sessions'),
      binaryArgs: [path.join(__dirname, 'fixtures/codex-cli.cjs'), mode],
    });
    vi.stubEnv('FAKE_CODEX_SESSIONS', path.join(root, 'sessions'));
    const developer = parse(
      fs.readFileSync(path.join(__dirname, '../../agents/templates/developer.yaml'), 'utf8'),
    );
    const events = await drain(executor.start({ ...req, agentSpec: developer }).events);
    expect(events.at(-1)).toMatchObject({
      type: 'finished',
      exitCode: 1,
      resultSummary: expect.stringContaining(`Policy violation: Codex attempted ${rule}`),
    });
    expect(denials()).toEqual([
      expect.objectContaining({
        actorId: 'codex',
        outcome: expect.objectContaining({ detail: rule }),
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('TEST_SECRET');
    expect(events.some((event) => event.type === 'guardCorrection')).toBe(
      mode === '--claude-shell-write',
    );
  });
});
