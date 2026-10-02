import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import type { ProjectOperatorConfig } from '../../core/src/project.js';
import {
  companyAutopilotKey,
  readConfig,
  setHooksEnabled,
  writeConfig,
} from '../src/configPersistence.js';
import { loadProjectConfig } from '../src/projectConfig.js';
import { SchemaValidationError } from '../src/schemaValidation.js';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(() => process.env.HOME ?? actual.homedir()) };
});

describe('Project config authority boundary', () => {
  let temp: string;
  let repo: string;
  let originalHome: string | undefined;
  const manifest = () => ({
    apiVersion: 'softwareagents.io/v1alpha1',
    kind: 'Project',
    id: 'sample-project',
    name: 'Sample',
    repo: { remote: 'https://example.com/sample.git', defaultBranch: 'main' },
    brain: { path: '.softwareagents/brain' },
    clickup: { workspaceId: '123', folderId: '456', listIds: ['789'] },
    legacy: { boardFile: 'docs/backlog/board.json' },
  });
  function writeManifest(value: unknown) {
    fs.writeFileSync(path.join(repo, '.softwareagents/project.yaml'), stringify(value));
  }
  const policy: ProjectOperatorConfig = {
    autonomyLevel: 'A2',
    allowedExecutors: ['codex'],
    binaryPaths: { codex: 'C:\\bin\\codex.exe' },
    quotaThresholds: { codex: 20 },
    concurrency: { maxExecutions: 2, perExecutor: { codex: 1 } },
    budgets: { maxTokens: 1000, maxCostUsd: 0, maxExecutionSeconds: 60 },
    autopilot: { command: ['manager', '--start', ''], stateFile: 'runtime/state.json' },
  };
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-config-'));
    repo = path.join(temp, 'repo');
    fs.mkdirSync(path.join(repo, '.softwareagents'), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = path.join(temp, 'home');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(temp, { recursive: true, force: true });
  });
  it('loads valid YAML with canonical paths and operator policy without writing either file', () => {
    writeManifest(manifest());
    const config = readConfig();
    config.projects['sample-project'] = policy;
    writeConfig(config);
    const write = vi.spyOn(fs, 'writeFileSync');
    const loaded = loadProjectConfig(repo);
    expect(loaded?.project).toEqual(manifest());
    expect(loaded?.operator).toEqual(policy);
    expect(loaded?.paths).toEqual({
      brain: path.join(fs.realpathSync.native(repo), '.softwareagents/brain'),
      boardFile: path.join(fs.realpathSync.native(repo), 'docs/backlog/board.json'),
    });
    expect(write).not.toHaveBeenCalled();
  });
  it('returns null without a manifest and keeps legacy config usable', () => {
    expect(loadProjectConfig(repo)).toBeNull();
    expect(readConfig().standalone.soundEnabled).toBe(true);
  });
  it('defaults to A0 and no executors without operator authorization', () => {
    writeManifest(manifest());
    expect(loadProjectConfig(repo)?.operator).toEqual({
      autonomyLevel: 'A0',
      allowedExecutors: [],
    });
  });
  it('reports nested invalid fields and missing fields without coercing ClickUp ids', () => {
    const value = manifest();
    writeManifest({ ...value, name: undefined, clickup: { ...value.clickup, workspaceId: 123 } });
    expect(() => loadProjectConfig(repo)).toThrow('/name');
    expect(() => loadProjectConfig(repo)).toThrow('/clickup/workspaceId');
  });
  it.each(['autonomyLevel', 'executors', 'allowedExecutors', 'autopilot'])(
    'rejects authority field %s',
    (field) => {
      writeManifest({ ...manifest(), [field]: 'A4' });
      expect(() => loadProjectConfig(repo)).toThrow(`/${field}`);
    },
  );
  it('rejects unknown nested properties', () => {
    writeManifest({ ...manifest(), brain: { path: 'brain', autonomyLevel: 'A4' } });
    expect(() => loadProjectConfig(repo)).toThrow('/brain/autonomyLevel');
  });
  it.each(['../outside', 'C:\\outside', '/outside', 'docs/../outside'])(
    'rejects escaping brain path %s',
    (value) => {
      writeManifest({ ...manifest(), brain: { path: value } });
      expect(() => loadProjectConfig(repo)).toThrow('/brain/path');
    },
  );
  it('rejects escaping legacy board path', () => {
    writeManifest({ ...manifest(), legacy: { boardFile: '../board.json' } });
    expect(() => loadProjectConfig(repo)).toThrow('/legacy/boardFile');
  });
  it('rejects a directory link escaping the repo, even with missing suffixes', () => {
    const outside = path.join(temp, 'outside');
    fs.mkdirSync(outside);
    const link = path.join(repo, 'linked');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      writeManifest({ ...manifest(), brain: { path: 'linked/missing/brain' } });
      expect(() => loadProjectConfig(repo)).toThrow('/brain/path');
    } finally {
      fs.unlinkSync(link);
    }
  });
  it('rejects a manifest directory linked outside the repo', () => {
    fs.rmdirSync(path.join(repo, '.softwareagents'));
    const outside = path.join(temp, 'outside');
    fs.mkdirSync(outside);
    const link = path.join(repo, '.softwareagents');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(() => loadProjectConfig(repo)).toThrow('/project.yaml');
    } finally {
      fs.unlinkSync(link);
    }
  });
  it.each(['name: [', 'name: first\nname: duplicate'])('reports malformed YAML %s', (source) => {
    fs.writeFileSync(path.join(repo, '.softwareagents/project.yaml'), source);
    expect(() => loadProjectConfig(repo)).toThrow(SchemaValidationError);
    expect(() => loadProjectConfig(repo)).toThrow('/project.yaml');
  });
  it('preserves projects and companyAutopilot through ordinary settings writes', () => {
    const config = readConfig();
    config.projects['sample-project'] = policy;
    config.companyAutopilot[companyAutopilotKey(repo)] = { command: ['legacy-manager'] };
    writeConfig(config);
    setHooksEnabled('claude', false);
    const reloaded = readConfig();
    expect(reloaded.projects['sample-project']).toEqual(policy);
    expect(reloaded.companyAutopilot[companyAutopilotKey(repo)]).toEqual({
      command: ['legacy-manager'],
    });
    writeManifest(manifest());
    expect(loadProjectConfig(repo)?.operator.autopilot?.command[0]).toBe('manager');
  });
  it.each([
    { ...policy, autonomyLevel: 'A5' },
    { ...policy, allowedExecutors: 'codex' },
    { ...policy, quotaThresholds: { codex: 101 } },
    { ...policy, concurrency: { maxExecutions: -1 } },
    { ...policy, budgets: { maxCostUsd: -1 } },
    { ...policy, autopilot: { command: [''] } },
  ])('drops malformed operator policies without granting partial authority', (invalid) => {
    const directory = path.join(process.env.HOME!, '.pixel-agents');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'config.json'),
      JSON.stringify({ projects: { 'sample-project': invalid } }),
    );
    writeManifest(manifest());
    expect(loadProjectConfig(repo)?.operator).toEqual({
      autonomyLevel: 'A0',
      allowedExecutors: [],
    });
  });
});
