import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditLog } from '../src/auditLog.js';
import { dispatchCli, parseArgs } from '../src/cli.js';
import type { ClientMessageContext } from '../src/clientMessageHandler.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { runProjectCommand } from '../src/commands/project.js';
import * as company from '../src/companyControl.js';
import { PROJECT_BRAIN_PATH, PROJECT_MANIFEST_PATH } from '../src/constants.js';
import { readIdeas } from '../src/featureIdeas.js';
import { loadProjectConfig } from '../src/projectConfig.js';
import {
  handlePrepareProjectMessage,
  inspectProjectPreparation,
  prepareProject,
} from '../src/projectPreparation.js';
import { operatorToken } from './helpers/operatorToken.js';

vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));
vi.mock('fs', async (original) => {
  const actual = await original<typeof import('fs')>();
  return { ...actual, linkSync: vi.fn(actual.linkSync) };
});

const managedMarkers = ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'];

describe('SA-114 project preparation', () => {
  let temporary: string;
  let root: string;
  let home: string;
  const manifestFile = () => path.join(root, PROJECT_MANIFEST_PATH);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe', encoding: 'utf8' });

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    vi.mocked(fs.linkSync).mockReset().mockImplementation(actual.linkSync);
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'project-preparation-'));
    root = path.join(temporary, 'Mi proyecto');
    home = path.join(temporary, 'home');
    fs.mkdirSync(root);
    fs.mkdirSync(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('XDG_CONFIG_HOME', home);
    for (const marker of managedMarkers) vi.stubEnv(marker, undefined);
    vi.stubEnv('PIXEL_AGENTS_OPERATOR_TOKEN', undefined);
    git('init', '--quiet', '--initial-branch=main');
    vi.spyOn(company, 'companyWorkspaceRoot').mockReturnValue(root);
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    // Remove any test junction itself before recursively removing its parent.
    for (const relative of [PROJECT_BRAIN_PATH, PROJECT_MANIFEST_PATH, '.softwareagents']) {
      const entry = path.join(root, relative);
      try {
        if (fs.lstatSync(entry).isSymbolicLink()) fs.unlinkSync(entry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  it('creates accepted data-only YAML and a brain directory at the discovered root', () => {
    const child = path.join(root, 'nested');
    fs.mkdirSync(child);
    const originalGitConfig = fs.readFileSync(path.join(root, '.git/config'), 'utf8');
    const originalHead = fs.readFileSync(path.join(root, '.git/HEAD'), 'utf8');
    const name = 'Nombre: "datos" # español ${literal}';
    const proposal = inspectProjectPreparation(child, name).proposal;
    expect(proposal).toMatchObject({
      name,
      defaultBranch: 'main',
      remote: 'local',
      brainPath: PROJECT_BRAIN_PATH,
    });
    expect(inspectProjectPreparation(root).proposal.id).toBe(proposal.id);
    expect(prepareProject(child, name, true)).toEqual({
      projectId: proposal.id,
      status: 'created',
      errorCode: null,
    });
    const loaded = loadProjectConfig(root)!;
    expect(loaded.project.name).toBe(name);
    expect(loaded.operator).toEqual({ autonomyLevel: 'A0', allowedExecutors: [] });
    expect(fs.statSync(loaded.paths.brain).isDirectory()).toBe(true);
    expect(fs.readdirSync(path.join(root, '.softwareagents')).sort()).toEqual([
      'brain',
      'project.yaml',
    ]);
    expect(fs.readFileSync(path.join(root, '.git/config'), 'utf8')).toBe(originalGitConfig);
    expect(fs.readFileSync(path.join(root, '.git/HEAD'), 'utf8')).toBe(originalHead);
    expect(fs.existsSync(path.join(root, '.git/index'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.git/softwareagents'))).toBe(false);
    const audit = fs.readFileSync(
      path.join(home, '.pixel-agents/audit', `${proposal.id}.jsonl`),
      'utf8',
    );
    expect(audit).not.toContain(name);
    expect(audit).not.toContain(root);
    expect(
      audit
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).outcome.status),
    ).toEqual(['pending', 'created']);
    expect(readIdeas('after', true, root)).toMatchObject({
      canSubmit: true,
      projectId: proposal.id,
    });
  });

  it.each(['valid', 'invalid'])('refuses overwrite of an existing %s manifest', (kind) => {
    if (kind === 'valid') expect(prepareProject(root, 'Original', true).status).toBe('created');
    else {
      fs.mkdirSync(path.dirname(manifestFile()));
      fs.writeFileSync(manifestFile(), 'invalid: [yaml');
    }
    const previous = fs.readFileSync(manifestFile(), 'utf8');
    expect(prepareProject(root, 'Replacement', true)).toMatchObject({
      status: 'rejected',
      errorCode: 'already_exists',
    });
    expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(previous);
  });

  it('checks connection privilege before any repository probing', () => {
    expect(prepareProject('/missing', 'Private', false)).toMatchObject({ errorCode: 'denied' });
    const send = vi.fn();
    handlePrepareProjectMessage(
      { type: 'prepareProject', requestId: 'r', name: 'Private' },
      send,
      false,
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected', errorCode: 'denied' }),
    );
    expect(readIdeas('r', false, root)).not.toHaveProperty('preparation');
    expect(fs.existsSync(path.join(home, '.pixel-agents'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.softwareagents'))).toBe(false);
  });

  it('keeps the winner and its Brain when another writer publishes first', () => {
    const link = vi.mocked(fs.linkSync).getMockImplementation()!;
    vi.mocked(fs.linkSync).mockImplementationOnce((existing, destination) => {
      fs.writeFileSync(destination, 'winner');
      link(existing, destination);
    });
    expect(prepareProject(root, 'Loser', true)).toMatchObject({ errorCode: 'already_exists' });
    expect(fs.readFileSync(manifestFile(), 'utf8')).toBe('winner');
    expect(fs.statSync(path.join(root, PROJECT_BRAIN_PATH)).isDirectory()).toBe(true);
    expect(fs.readdirSync(path.dirname(manifestFile())).sort()).toEqual(['brain', 'project.yaml']);
  });

  it('cleans an interrupted publication without exposing a partial manifest and permits retry', () => {
    vi.mocked(fs.linkSync).mockImplementationOnce(() => {
      throw new Error('publication failed');
    });
    expect(prepareProject(root, 'Interrupted', true)).toMatchObject({
      errorCode: 'unsafe_storage',
    });
    expect(fs.existsSync(manifestFile())).toBe(false);
    expect(fs.readdirSync(path.dirname(manifestFile()))).toEqual(['brain']);
    expect(prepareProject(root, 'Retried', true).status).toBe('created');
    expect(loadProjectConfig(root)?.project.name).toBe('Retried');
  });

  it('aborts on an audit intent failure and reports a durable creation if audit confirmation fails', () => {
    const append = AuditLog.prototype.append;
    const audit = vi.spyOn(AuditLog.prototype, 'append').mockImplementationOnce(() => {
      throw new Error('audit unavailable');
    });
    expect(prepareProject(root, 'Pending', true)).toMatchObject({
      status: 'rejected',
      errorCode: 'audit_failed',
    });
    expect(fs.existsSync(path.join(root, '.softwareagents'))).toBe(false);
    audit.mockImplementation(function (this: AuditLog, input) {
      if (input.outcome.status === 'created') throw new Error('audit confirmation unavailable');
      return append.call(this, input);
    });
    expect(prepareProject(root, 'Durable', true)).toMatchObject({
      status: 'created',
      errorCode: 'audit_failed',
    });
    expect(loadProjectConfig(root)?.project.name).toBe('Durable');
  });

  it.each(managedMarkers)('refuses the managed marker %s even when empty', async (marker) => {
    vi.stubEnv(marker, '');
    expect(prepareProject(root, 'Managed', true)).toMatchObject({ errorCode: 'denied' });
    const send = vi.fn();
    handlePrepareProjectMessage(
      { type: 'prepareProject', requestId: 'r', name: 'Managed' },
      send,
      true,
    );
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'denied' }));
    await expect(runProjectCommand(['init', '--yes'])).rejects.toThrow('gestionados');
    expect(fs.existsSync(path.join(root, '.softwareagents'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.pixel-agents'))).toBe(false);
  });

  it('refuses a directory outside Git and explains it in the office snapshot', () => {
    expect(prepareProject(home, 'Outside', true)).toMatchObject({ errorCode: 'not_git' });
    expect(readIdeas('r', true, home)).toMatchObject({
      canSubmit: false,
      preparationError: 'not_git',
    });
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('refuses an escaping directory symlink or junction', () => {
    fs.symlinkSync(
      home,
      path.join(root, '.softwareagents'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(prepareProject(root, 'Escape', true)).toMatchObject({ errorCode: 'unsafe_storage' });
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('refuses a brain link and a dangling manifest link', () => {
    const directory = path.join(root, '.softwareagents');
    fs.mkdirSync(directory);
    const brain = path.join(root, PROJECT_BRAIN_PATH);
    fs.symlinkSync(home, brain, process.platform === 'win32' ? 'junction' : 'dir');
    expect(prepareProject(root, 'Escape', true)).toMatchObject({ errorCode: 'unsafe_storage' });
    fs.unlinkSync(brain);
    // A directory junction at the file path is also an existing entry, even if dangling.
    fs.symlinkSync(
      path.join(home, 'absent'),
      manifestFile(),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(prepareProject(root, 'Dangling', true)).toMatchObject({ errorCode: 'already_exists' });
    fs.unlinkSync(manifestFile());
  });

  it.each([
    'https://user:fake-password@example.com/team/repo.git?access_token=fake-query#fake-fragment',
    'ssh://user:fake-password@example.com/team/repo.git?access_token=fake-query#fake-fragment',
  ])('removes credentials before preview, persistence and audit for %s', (remote) => {
    git('config', 'remote.origin.url', remote);
    const proposal = inspectProjectPreparation(root).proposal;
    expect(proposal.remote).not.toContain('@');
    expect(proposal.remote).not.toContain('fake-');
    expect(prepareProject(root, 'Remote', true).status).toBe('created');
    const saved = fs.readFileSync(manifestFile(), 'utf8');
    const audit = fs.readFileSync(
      path.join(home, '.pixel-agents/audit', `${proposal.id}.jsonl`),
      'utf8',
    );
    expect(saved + audit).not.toContain('fake-');
    expect(saved + audit).not.toContain('user:');
    expect(loadProjectConfig(root)?.project.repo.remote).toBe(proposal.remote);
  });

  it('detects origin HEAD and sanitizes the common SSH remote syntax', () => {
    git('config', 'remote.origin.url', 'git@example.com:team/repo.git');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    expect(inspectProjectPreparation(root).proposal).toMatchObject({
      name: 'Mi proyecto',
      defaultBranch: 'trunk',
      remote: 'ssh://example.com/team/repo.git',
    });
  });

  it.each(['', '   ', 'bad\nname', '\u0000', '\ud800', 'a'.repeat(121)])(
    'validates the name before writes (%j)',
    (name) => {
      expect(prepareProject(root, name, true)).toMatchObject({ errorCode: 'invalid_request' });
      expect(fs.existsSync(path.join(root, '.softwareagents'))).toBe(false);
      expect(fs.readdirSync(home)).toEqual([]);
    },
  );

  it('refuses a reused Operator identity', () => {
    const id = inspectProjectPreparation(root).proposal.id;
    fs.mkdirSync(path.join(home, '.pixel-agents'));
    fs.writeFileSync(
      path.join(home, '.pixel-agents/config.json'),
      JSON.stringify({ projects: { [id]: { autonomyLevel: 'A3', allowedExecutors: ['claude'] } } }),
    );
    expect(prepareProject(root, 'Collision', true)).toMatchObject({
      errorCode: 'operator_conflict',
    });
    expect(fs.existsSync(manifestFile())).toBe(false);
  });

  it('returns an actionable proposal for an unprepared office', () => {
    expect(readIdeas('r', true, root)).toMatchObject({
      canSubmit: false,
      errorCode: 'missing_manifest',
      preparation: {
        name: 'Mi proyecto',
        defaultBranch: 'main',
        configPath: PROJECT_MANIFEST_PATH,
      },
    });
  });

  it('handles the normal message entry point and refuses client-selected paths and the VS Code adapter', () => {
    const send = vi.fn();
    const context = {
      store: {
        getAdapter: () => undefined,
        bindProjectWorkspace: vi.fn(),
        broadcast: vi.fn(),
        notifyExecutorStateChanged: vi.fn(),
      },
      privileged: true,
    } as unknown as ClientMessageContext;
    const message = { type: 'prepareProject', requestId: 'r', name: 'Office' };
    handleClientMessage({ ...message, root: home }, send, context);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ errorCode: 'invalid_request' }),
    );
    handleClientMessage(message, send, { ...context, ideasSupported: false });
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ errorCode: 'unsupported_adapter' }),
    );
    expect(fs.existsSync(manifestFile())).toBe(false);
    handleClientMessage(message, send, context);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'created', requestId: 'r' }),
    );
    expect(loadProjectConfig(root)?.project.name).toBe('Office');
  });

  it('lists project init in top-level CLI help', () => {
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('help exit');
    });
    expect(() => parseArgs(['--help'])).toThrow('help exit');
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('project init [--name <name>] [--yes]'),
    );
  });

  it('CLI without a confirmation creates nothing', async () => {
    const previous = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    try {
      await expect(dispatchCli(['project', 'init'])).rejects.toThrow('confirmación interactiva');
      expect(fs.existsSync(path.join(root, '.softwareagents'))).toBe(false);
      expect(fs.readdirSync(home)).toEqual([]);
    } finally {
      if (previous) Object.defineProperty(process.stdin, 'isTTY', previous);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
    }
  });

  it('CLI --yes authenticates through existing human ingress and shares the service', async () => {
    operatorToken(home);
    await dispatchCli(['project', 'init', '--name', 'Desde CLI', '--yes']);
    expect(loadProjectConfig(root)?.project.name).toBe('Desde CLI');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('commit tú mismo'));
  });

  it('CLI --yes still refuses creation without the operator capability', async () => {
    const previous = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    try {
      await expect(dispatchCli(['project', 'init', '--yes'])).rejects.toThrow(
        'PIXEL_AGENTS_OPERATOR_TOKEN',
      );
      expect(fs.existsSync(path.join(root, '.softwareagents'))).toBe(false);
      expect(fs.readdirSync(home)).toEqual([]);
    } finally {
      if (previous) Object.defineProperty(process.stdin, 'isTTY', previous);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
    }
  });
});
