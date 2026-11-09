import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { AuditLog } from '../src/auditLog.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import {
  answerDecision,
  autopilotStatePath,
  configureCompanyControl,
  readAutopilot,
  setAutopilot,
} from '../src/companyControl.js';
import {
  companyAutopilotKey,
  parseCompanyAutopilot,
  readConfig,
  setHooksEnabled,
  writeConfig,
} from '../src/configPersistence.js';
import { resolveInside } from '../src/pathGuard.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    // Windows os.homedir() ignores HOME; honor it to avoid writing to the real user profile.
    homedir: vi.fn(() => process.env.HOME ?? actual.homedir()),
  };
});

vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
}));

vi.mock('child_process', () => ({ execFileSync: vi.fn(), spawn: vi.fn() }));

describe('companyControl authorization and containment', () => {
  let root: string;
  let workspace: string;
  let gitDir: string;
  let boardFile: string;
  const command = ['trusted-supervisor', '--interval', '20'];
  const invalidPaths = [
    '/outside.json',
    'C:\\outside.json',
    'C:outside.json',
    '\\\\host\\share\\outside.json',
    '../outside.json',
    'sub/../outside.json',
    '..\\outside.json',
  ];

  function board(
    autopilot: unknown = { command, stateFile: 'state.json' },
    decisionsFile = 'decisions.json',
  ): void {
    fs.writeFileSync(boardFile, JSON.stringify({ autopilot, decisionsFile }));
  }

  function authorize(stateFile?: string): void {
    const cfg = readConfig();
    cfg.companyAutopilot[companyAutopilotKey(workspace)] = {
      command,
      ...(stateFile !== undefined ? { stateFile } : {}),
    };
    writeConfig(cfg);
  }

  beforeEach(() => {
    // Canonical: Windows TEMP may be in 8.3 short form (RUNNER~1) on CI.
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'company-control-')));
    workspace = path.join(root, 'workspace');
    gitDir = path.join(root, 'git-common');
    fs.mkdirSync(path.join(workspace, 'docs', 'backlog'), { recursive: true });
    fs.mkdirSync(gitDir);
    boardFile = path.join(workspace, 'docs', 'backlog', 'board.json');
    vi.mocked(os.homedir).mockReturnValue(root);
    vi.mocked(childProcess.execFileSync).mockReturnValue(gitDir);
    vi.mocked(childProcess.spawn).mockReturnValue({
      pid: 123,
      unref: vi.fn(),
    } as unknown as ReturnType<typeof childProcess.spawn>);
    configureCompanyControl(workspace);
    board();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('audits successful controls with the real policy verdict and rejected answers with their outcome', () => {
    authorize('state.json');
    fs.writeFileSync(
      path.join(workspace, 'decisions.json'),
      JSON.stringify({
        decisions: [{ id: 'D1', options: ['yes'] }],
      }),
    );
    const ctx = { store: new AgentStateStore(), cache: null, privileged: true };
    handleClientMessage({ type: 'companyAutopilot', enabled: false }, vi.fn(), ctx);
    handleClientMessage({ type: 'companyDecision', id: 'D1', answer: 'yes' }, vi.fn(), ctx);
    handleClientMessage({ type: 'companyDecision', id: 'D1', answer: 'invalid' }, vi.fn(), ctx);
    const lines = new AuditLog().read(null);
    expect(lines).toHaveLength(3);
    expect(
      lines.map((line) =>
        line.corrupt
          ? null
          : [line.entry.action, line.entry.outcome.status, line.entry.policyDecision?.outcome],
      ),
    ).toEqual([
      ['companyAutopilot', 'success', 'allow'],
      ['companyDecision', 'success', 'allow'],
      ['companyDecision', 'rejected', 'allow'],
    ]);
    ctx.store.dispose();
  });

  it.each([
    ['broken YAML', 'brain: [', '/project.yaml'],
    ['invalid schema', '{}', '/apiVersion'],
    [
      'escaping path',
      JSON.stringify({
        apiVersion: 'softwareagents.io/v1alpha1',
        kind: 'Project',
        id: 'sample',
        name: 'Sample',
        repo: { remote: 'https://example.com/sample.git', defaultBranch: 'main' },
        brain: { path: '../outside' },
      }),
      '/brain/path',
    ],
  ])('disables company control for %s even with operator authority', (_name, manifest, field) => {
    authorize('state.json');
    fs.mkdirSync(path.join(workspace, '.softwareagents'));
    fs.writeFileSync(path.join(workspace, '.softwareagents/project.yaml'), manifest);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = vi.spyOn(fs, 'writeFileSync');
    expect(() => configureCompanyControl(workspace)).not.toThrow();
    expect(autopilotStatePath()).toBeUndefined();
    expect(readAutopilot()).toBeUndefined();
    for (const enabled of [true, false]) expect(setAutopilot(enabled)).toContain(field);
    expect(answerDecision('D1', 'yes')).toContain(field);
    const send = vi.fn();
    handleClientMessage({ type: 'companyAutopilot', enabled: true }, send, {
      store: new AgentStateStore(),
      cache: null,
      privileged: true,
    });
    expect(send).toHaveBeenCalledWith({
      type: 'companyNotice',
      text: expect.stringContaining('invalid .softwareagents/project.yaml'),
    });
    // Denied controls may append audit entries, but may not write company state.
    expect(write.mock.calls.every(([target]) => typeof target === 'number')).toBe(true);
    expect(new AuditLog().read(null)).toHaveLength(4);
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(field));
    expect(fs.readdirSync(gitDir)).toEqual([]);
  });

  it('answers decisions from the board selected by project.yaml', () => {
    fs.mkdirSync(path.join(workspace, '.softwareagents'));
    fs.mkdirSync(path.join(workspace, 'custom'));
    fs.writeFileSync(
      path.join(workspace, '.softwareagents/project.yaml'),
      JSON.stringify({
        apiVersion: 'softwareagents.io/v1alpha1',
        kind: 'Project',
        id: 'sample',
        name: 'Sample',
        repo: { remote: 'https://example.com/sample.git', defaultBranch: 'main' },
        brain: { path: '.softwareagents/brain' },
        legacy: { boardFile: 'custom/board.json' },
      }),
    );
    fs.writeFileSync(
      path.join(workspace, 'custom/board.json'),
      JSON.stringify({
        decisionsFile: 'custom/decisions.json',
        autopilot: { stateFile: 'custom-state.json' },
      }),
    );
    const inbox = path.join(workspace, 'custom/decisions.json');
    fs.writeFileSync(inbox, JSON.stringify({ decisions: [{ id: 'opaque', options: ['yes'] }] }));
    configureCompanyControl(workspace);
    expect(answerDecision('opaque', 'yes')).toContain('guardada');
    expect(JSON.parse(fs.readFileSync(inbox, 'utf8')).decisions[0].status).toBe('answered');
    expect(autopilotStatePath()).toBe(path.join(gitDir, 'custom-state.json'));
  });

  it('lets a privileged client pause after authorization is revoked despite changed board argv', () => {
    authorize();
    setAutopilot(true);
    const cfg = readConfig();
    delete cfg.companyAutopilot[companyAutopilotKey(workspace)];
    writeConfig(cfg);
    board({ command: ['changed-command'], stateFile: 'state.json' });
    vi.mocked(childProcess.spawn).mockClear();
    handleClientMessage({ type: 'companyAutopilot', enabled: false }, vi.fn(), {
      store: new AgentStateStore(),
      cache: null,
      privileged: true,
    });
    expect(JSON.parse(fs.readFileSync(path.join(gitDir, 'state.json'), 'utf8')).enabled).toBe(
      false,
    );
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it.each(invalidPaths)(
    'rejects unsafe stateFile %s when pausing without authorization',
    (stateFile) => {
      board({ stateFile });
      expect(setAutopilot(false)).toContain('stateFile rechazada');
      expect(childProcess.spawn).not.toHaveBeenCalled();
      expect(fs.readdirSync(gitDir)).toEqual([]);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'matches Windows workspace keys regardless of casing',
    () => {
      const cfg = readConfig();
      cfg.companyAutopilot[workspace.toUpperCase()] = { command, stateFile: 'operator-state.json' };
      writeConfig(cfg);
      expect(setAutopilot(true)).toContain('en marcha');
      expect(autopilotStatePath()).toBe(path.join(gitDir, 'operator-state.json'));
    },
  );

  it.skipIf(process.platform === 'win32')('preserves POSIX workspace key casing', () => {
    expect(companyAutopilotKey('/Source/Project')).toBe('/Source/Project');
    expect(companyAutopilotKey('/source/project')).toBe('/source/project');
  });

  it('rejects an unauthorized board without launching or writing', () => {
    expect(setAutopilot(true)).toContain('no autorizado');
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(fs.readdirSync(gitDir)).toEqual([]);
  });

  it.each(
    [
      ['other-binary', '--interval', '20'],
      ['trusted-supervisor', '--interval', '1'],
      [...command, '--extra'],
      command.slice(0, 2),
      'trusted-supervisor',
    ].map((changed) => [changed]),
  )('rejects changed board argv %j', (changed) => {
    authorize();
    board({ command: changed, stateFile: 'state.json' });
    expect(setAutopilot(true)).toContain('no coincide exactamente');
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(fs.readdirSync(gitDir)).toEqual([]);
  });

  it('launches the exact operator argv when the board matches', () => {
    authorize();
    expect(setAutopilot(true)).toContain('en marcha');
    expect(childProcess.spawn).toHaveBeenCalledWith(command[0], command.slice(1), {
      cwd: workspace,
      env: { ...process.env, SA_MANAGED_EXECUTION: 'autopilot' },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(JSON.parse(fs.readFileSync(path.join(gitDir, 'state.json'), 'utf8')).enabled).toBe(true);
  });

  it('cannot switch arguments by changing the board after an authorized launch', () => {
    authorize();
    setAutopilot(true);
    const file = path.join(gitDir, 'state.json');
    const before = fs.readFileSync(file, 'utf8');
    vi.mocked(childProcess.spawn).mockClear();
    board({ command: [...command, '--execute-other-task'], stateFile: 'state.json' });
    expect(setAutopilot(true)).toContain('no coincide exactamente');
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('does not launch a second supervisor when the recorded process is alive', () => {
    authorize();
    vi.spyOn(process, 'kill').mockReturnValue(true);
    fs.writeFileSync(path.join(gitDir, 'state.json'), JSON.stringify({ pid: 123 }));
    expect(readAutopilot()).toMatchObject({ pid: 123, running: true });
    expect(setAutopilot(true)).toContain('activado');
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('uses operator stateFile and supports a board without command', () => {
    authorize('operator-state.json');
    board({ stateFile: '../outside.json' });
    expect(setAutopilot(true)).toContain('en marcha');
    expect(autopilotStatePath()).toBe(path.join(gitDir, 'operator-state.json'));
  });

  it.each(invalidPaths)('rejects board stateFile %s without writing', (stateFile) => {
    authorize();
    board({ command, stateFile });
    expect(setAutopilot(true)).toContain('stateFile rechazada');
    expect(readAutopilot()).toBeUndefined();
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(fs.readdirSync(gitDir)).toEqual([]);
    expect(fs.existsSync(path.join(root, 'outside.json'))).toBe(false);
  });

  it.each(invalidPaths)('rejects operator stateFile %s', (stateFile) => {
    authorize(stateFile);
    expect(setAutopilot(true)).toContain('stateFile rechazada');
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(fs.readdirSync(gitDir)).toEqual([]);
  });

  it.each(invalidPaths)(
    'rejects decisionsFile %s without touching the outside file',
    (decisionsFile) => {
      const outside = path.join(root, 'outside.json');
      fs.writeFileSync(outside, '{"decisions":[{"id":"D1","options":["yes"]}]}');
      const before = fs.readFileSync(outside, 'utf8');
      board(undefined, decisionsFile);
      expect(answerDecision('D1', 'yes')).toContain('decisionsFile rechazada');
      expect(fs.readFileSync(outside, 'utf8')).toBe(before);
      expect(fs.existsSync(outside + '.tmp')).toBe(false);
    },
  );

  it('accepts only listed decision options', () => {
    const file = path.join(workspace, 'decisions.json');
    fs.writeFileSync(file, JSON.stringify({ decisions: [{ id: 'D1', options: ['yes', 'no'] }] }));
    const before = fs.readFileSync(file, 'utf8');
    expect(answerDecision('D1', 'maybe')).toContain('opciones listadas');
    expect(answerDecision('unknown', 'yes')).toContain('No existe');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(answerDecision('D1', 'yes')).toContain('guardada');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).decisions[0]).toMatchObject({
      answer: 'yes',
      status: 'answered',
    });
  });

  it('reads a missing state file as paused and does not spawn on disable', () => {
    expect(readAutopilot()).toEqual({ enabled: false, status: 'paused', running: false });
    authorize();
    expect(setAutopilot(false)).toContain('en pausa');
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, true],
    [false, true],
    [undefined, false],
    [false, false],
  ])('rejects companyAutopilot without privilege %s (enabled %s)', (privileged, enabled) => {
    authorize();
    const send = vi.fn();
    handleClientMessage({ type: 'companyAutopilot', enabled }, send, {
      store: new AgentStateStore(),
      cache: null,
      privileged,
    });
    expect(send).toHaveBeenCalledWith({
      type: 'companyNotice',
      text: expect.stringContaining('Revisa el acceso en Settings'),
    });
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(fs.readdirSync(gitDir)).toEqual([]);
  });

  it('delivers the authorization refusal as a companyNotice to a privileged client', () => {
    const send = vi.fn();
    handleClientMessage({ type: 'companyAutopilot', enabled: true }, send, {
      store: new AgentStateStore(),
      cache: null,
      privileged: true,
    });
    expect(send).toHaveBeenCalledWith({
      type: 'companyNotice',
      text: expect.stringContaining('no autorizado'),
    });
  });

  it('preserves authorizations when another preference is written', () => {
    authorize();
    setHooksEnabled('claude', false);
    expect(readConfig().companyAutopilot[companyAutopilotKey(workspace)]).toEqual({ command });
  });

  it('drops malformed authorizations without filtering argv', () => {
    for (const value of [
      null,
      [],
      { command: [] },
      { command: ['bin', 42] },
      { command: [''] },
      { command: ['bin\0'] },
      { command, stateFile: 42 },
    ]) {
      expect(parseCompanyAutopilot({ [workspace]: value })).toEqual({});
    }
    expect(parseCompanyAutopilot({ relative: { command } })).toEqual({});
  });

  it.skipIf(process.platform === 'win32')(
    'writes config with mode 0600, including an existing temporary file',
    () => {
      authorize();
      const file = path.join(root, '.pixel-agents', 'config.json');
      fs.writeFileSync(file + '.tmp', 'old', { mode: 0o666 });
      authorize();
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    },
  );

  it('resolves safe nested paths and rejects the root itself', () => {
    expect(resolveInside(workspace, 'docs/decisions.json')).toBe(
      path.join(workspace, 'docs', 'decisions.json'),
    );
    expect(() => resolveInside(workspace, '.')).toThrow();
  });
});
