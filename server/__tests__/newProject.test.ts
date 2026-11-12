import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { projectNameProposals } from '../../core/src/projectNaming.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { loadBoardSelection } from '../src/boardSources.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import * as company from '../src/companyControl.js';
import { readConfig } from '../src/configPersistence.js';
import { createDomainEventRelay } from '../src/domainEventRelay.js';
import { evalGit } from '../src/evalTasks.js';
import { handleNewProjectMessage } from '../src/newProject.js';
import { loadProjectConfig } from '../src/projectConfig.js';
import * as preparation from '../src/projectPreparation.js';

vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => process.env.HOME!,
}));
vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, accessSync: vi.fn(actual.accessSync), statfsSync: vi.fn(actual.statfsSync) };
});

const markers = ['SA_MANAGED_EXECUTION', 'SA_AUTOPILOT', 'SA_WORKER', 'CLAUDECODE'];
let temporary: string;
let parent: string;
const draft = () => ({
  name: 'Tienda de barrio',
  parentPath: parent,
  folderMode: 'create',
  hosting: 'local',
});
function request(type: string, fields: Record<string, unknown> = {}, privileged = true) {
  const replies: Record<string, unknown>[] = [];
  handleNewProjectMessage(
    { type, requestId: 'request', ...fields },
    (reply) => replies.push(reply),
    privileged,
  );
  expect(replies).toHaveLength(1);
  return replies[0];
}

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(fs.accessSync).mockReset().mockImplementation(actual.accessSync);
  vi.mocked(fs.statfsSync).mockReset().mockImplementation(actual.statfsSync);
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sa157-'));
  parent = path.join(temporary, 'projects');
  fs.mkdirSync(parent);
  const home = path.join(temporary, 'home');
  fs.mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  for (const marker of markers) vi.stubEnv(marker, undefined);
  vi.spyOn(company, 'companyWorkspaceRoot').mockReturnValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe('SA-157 deterministic project names', () => {
  it('uses accented context keywords and stable frequency order, with two to four choices', () => {
    const context = 'Quiero crear una aplicación de gestión de facturas. Facturas para una tienda.';
    const proposals = projectNameProposals(context);
    expect(proposals).toEqual(projectNameProposals(context));
    expect(proposals.length).toBeGreaterThanOrEqual(2);
    expect(proposals.length).toBeLessThanOrEqual(4);
    expect(proposals.every((name) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))).toBe(true);
    expect(proposals[0]).toContain('facturas');
    expect(projectNameProposals('')).toEqual(['nuevo-proyecto', 'mi-proyecto']);
    expect(projectNameProposals('x'.repeat(200))).toHaveLength(2);
    expect(projectNameProposals('COM1 NUL')).toHaveLength(2);
  });

  it('reads the latest idea and falls back to the current project name when there are no drafts', () => {
    const root = path.join(parent, 'current');
    fs.mkdirSync(path.join(root, '.softwareagents'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.softwareagents/project.yaml'),
      JSON.stringify({
        apiVersion: 'softwareagents.io/v1alpha1',
        kind: 'Project',
        id: 'current-context',
        name: 'Recibos del barrio',
        repo: { remote: 'local', defaultBranch: 'main' },
        brain: { path: '.softwareagents/brain' },
      }),
    );
    vi.mocked(company.companyWorkspaceRoot).mockReturnValue(root);
    expect(request('requestNewProject').proposals).toEqual(
      projectNameProposals('Recibos del barrio'),
    );
    const ideas = path.join(root, '.softwareagents', 'ideas', 'current-context');
    fs.mkdirSync(ideas, { recursive: true });
    fs.writeFileSync(
      path.join(ideas, 'FEAT-001.md'),
      '# Idea\n\n    Agenda veterinaria\n\n## Respuestas\n',
    );
    expect(request('requestNewProject').proposals).toEqual(
      projectNameProposals('Agenda veterinaria'),
    );
  });
});

describe('SA-157 human disk ingress', () => {
  it.each([
    'requestNewProject',
    'browseProjectDirectories',
    'validateNewProject',
    'createNewProject',
  ])('denies non-privileged %s before probing disk', (type) => {
    const probe = vi.spyOn(fs, 'lstatSync');
    expect(request(type, draft(), false)).toMatchObject({ errorCode: 'denied' });
    expect(probe).not.toHaveBeenCalled();
  });
  it.each(markers)('denies every disk step with even an empty %s marker', (marker) => {
    vi.stubEnv(marker, '');
    const probe = vi.spyOn(fs, 'lstatSync');
    for (const type of [
      'requestNewProject',
      'browseProjectDirectories',
      'validateNewProject',
      'createNewProject',
    ])
      expect(request(type, draft())).toMatchObject({ errorCode: 'denied' });
    expect(probe).not.toHaveBeenCalled();
  });
  it('rejects client-supplied authority', () => {
    expect(request('createNewProject', { ...draft(), actor: 'human' })).toMatchObject({
      errorCode: 'invalid_request',
    });
    expect(fs.readdirSync(parent)).toEqual([]);
  });
});

describe('SA-157 folder browser and destination checks', () => {
  it('starts at isolated home, lists directories only and persists the per-adapter default', () => {
    fs.mkdirSync(path.join(parent, 'carpeta'));
    fs.writeFileSync(path.join(parent, 'secret.txt'), 'not exposed');
    expect(request('browseProjectDirectories', { purpose: 'browse' }).path).toBe(process.env.HOME);
    expect(
      request('browseProjectDirectories', { path: parent, purpose: 'save_default' }),
    ).toMatchObject({
      directories: ['carpeta'],
      errorCode: null,
    });
    expect(readConfig().standalone.projectsParentDirectory).toBe(parent);
    expect(readConfig().vscode.projectsParentDirectory).toBe('');
    expect(request('requestNewProject').defaultParent).toBe(parent);
  });
  it.each(['', '  ', '\u0000', 'con', '...'])('rejects an invalid name %j', (name) => {
    expect(request('validateNewProject', { ...draft(), name })).toMatchObject({
      errorCode: 'invalid_request',
    });
  });
  it.each([
    '../outside',
    'C:relative',
    '\\relative-root',
    '\\\\server\\share',
    '\\\\?\\C:\\device',
  ])('rejects path tricks %j', (parentPath) => {
    expect(request('validateNewProject', { ...draft(), parentPath })).toMatchObject({
      errorCode: 'unsafe_path',
    });
  });
  it('rejects .git descendants, non-empty folders and conflicting manifests', () => {
    expect(
      request('validateNewProject', {
        ...draft(),
        parentPath: path.join(parent, '.git', 'objects'),
      }),
    ).toMatchObject({ errorCode: 'unsafe_path' });
    const target = path.join(parent, 'tienda-de-barrio');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
    expect(request('validateNewProject', draft())).toMatchObject({ errorCode: 'not_empty' });
    fs.mkdirSync(path.join(target, '.softwareagents'));
    fs.writeFileSync(path.join(target, '.softwareagents/project.yaml'), 'invalid yaml');
    expect(request('validateNewProject', draft())).toMatchObject({
      errorCode: 'conflicting_project',
    });
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('keep');
  });
  it('never follows a directory junction during validation or directory browsing', () => {
    const linked = path.join(parent, 'tienda-de-barrio');
    fs.symlinkSync(
      path.join(temporary, 'home'),
      linked,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    try {
      expect(request('validateNewProject', draft())).toMatchObject({ errorCode: 'unsafe_path' });
      expect(
        request('browseProjectDirectories', { path: parent, purpose: 'browse' }).directories,
      ).toEqual([]);
    } finally {
      fs.unlinkSync(linked);
    }
  });
  it('checks available space and write permission', () => {
    vi.mocked(fs.accessSync).mockImplementationOnce(() => {
      throw new Error('EACCES');
    });
    expect(request('validateNewProject', draft())).toMatchObject({ errorCode: 'unwritable' });
    const real = fs.statfsSync(parent, { bigint: true });
    vi.mocked(fs.statfsSync).mockReturnValueOnce({ ...real, bavail: 0n });
    expect(request('validateNewProject', draft())).toMatchObject({ errorCode: 'no_space' });
  });
  it('offers Git adoption explicitly and accepts only a matching existing Project', () => {
    const target = path.join(parent, 'tienda-de-barrio');
    fs.mkdirSync(target);
    evalGit(target, ['init', '--quiet', '--initial-branch=main']);
    expect(request('validateNewProject', draft())).toMatchObject({
      errorCode: 'existing_available',
      path: target,
    });
    expect(
      request('validateNewProject', { ...draft(), parentPath: target, folderMode: 'existing' }),
    ).toMatchObject({ status: 'ready' });
    const created = request('createNewProject', {
      ...draft(),
      parentPath: target,
      folderMode: 'existing',
    });
    expect(created.status).toBe('created');
    expect(
      request('validateNewProject', {
        ...draft(),
        parentPath: target,
        folderMode: 'existing',
        name: 'Otro nombre',
      }),
    ).toMatchObject({ errorCode: 'conflicting_project' });
    expect(
      request('createNewProject', { ...draft(), parentPath: target, folderMode: 'existing' }),
    ).toMatchObject({ status: 'created', projectId: created.projectId });
  });
});

describe('SA-157 creation and office binding', () => {
  it('uses canonical preparation and git init in a temporary folder and returns the hosting choice', () => {
    const prepare = vi.spyOn(preparation, 'prepareProject');
    const result = request('createNewProject', { ...draft(), hosting: 'github_private' });
    const target = path.join(parent, 'tienda-de-barrio');
    expect(result).toMatchObject({
      status: 'created',
      path: target,
      hosting: 'github_private',
      errorCode: null,
    });
    expect(prepare).toHaveBeenCalledWith(target, 'Tienda de barrio', true);
    expect(evalGit(target, ['rev-parse', '--is-inside-work-tree'])).toBe('true');
    expect(loadProjectConfig(target)?.project.name).toBe('Tienda de barrio');
    expect(fs.statSync(path.join(target, '.softwareagents/brain')).isDirectory()).toBe(true);
    expect(evalGit(target, ['remote'])).toBe('');
  });
  it('revalidates after preview and never overwrites newly occupied folders', () => {
    expect(request('validateNewProject', draft()).status).toBe('ready');
    const target = path.join(parent, 'tienda-de-barrio');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep'), 'original');
    expect(request('createNewProject', draft())).toMatchObject({
      status: 'rejected',
      errorCode: 'not_empty',
    });
    expect(fs.readFileSync(path.join(target, 'keep'), 'utf8')).toBe('original');
  });
  it('uses the existing shared rebind callback and updates the selected Project snapshots', () => {
    const store = new AgentStateStore();
    let relay: ReturnType<typeof createDomainEventRelay>;
    const bind = vi.fn((root: string) => {
      relay = createDomainEventRelay(store, root, loadBoardSelection(root));
      relay?.start();
    });
    const snapshots: Record<string, unknown>[] = [];
    store.on('broadcast', (message) => snapshots.push(message));
    const replies: Record<string, unknown>[] = [];
    try {
      handleClientMessage(
        { type: 'createNewProject', requestId: 'create', ...draft() },
        (message) => replies.push(message),
        { store, cache: null, privileged: true, onProjectPrepared: bind },
      );
      expect(replies[0]).toMatchObject({ status: 'created', errorCode: null });
      expect(bind).toHaveBeenCalledWith(path.join(parent, 'tienda-de-barrio'));
      expect(snapshots).toContainEqual(
        expect.objectContaining({ type: 'workSnapshot', projectId: replies[0].projectId }),
      );
    } finally {
      relay?.dispose();
    }
  });
});
