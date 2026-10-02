import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { parseProjects } from '../src/configPersistence.js';
import { loadProjectConfig } from '../src/projectConfig.js';

// Validate the checked-in dogfooding manifest without reading the real Operator profile.
vi.mock('../src/configPersistence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/configPersistence.js')>();
  return { ...actual, readConfig: vi.fn(() => ({ projects: {} })) };
});

describe('SoftwareAgents dogfooding Project Brain', () => {
  it('loads the repository manifest with contained brain and exact ClickUp binding', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const loaded = loadProjectConfig(root);
    expect(loaded?.project).toEqual({
      apiVersion: 'softwareagents.io/v1alpha1',
      kind: 'Project',
      id: 'softwareagents',
      name: 'SoftwareAgents',
      repo: {
        remote: 'https://github.com/fedeggarrido/SoftwareAgents.git',
        defaultBranch: 'main',
      },
      brain: { path: '.softwareagents/brain' },
      clickup: {
        workspaceId: '90121540513',
        folderId: '901215250275',
        listIds: [
          '901222825471',
          '901222825474',
          '901222825475',
          '901222825477',
          '901222825478',
          '901222825479',
          '901222825480',
          '901222825482',
          '901222825483',
        ],
      },
    });
    expect(loaded?.paths.brain).toBe(
      path.join(fs.realpathSync.native(root), '.softwareagents/brain'),
    );
    expect(fs.statSync(loaded!.paths.brain).isDirectory()).toBe(true);
    expect(loaded?.operator).toEqual({ autonomyLevel: 'A0', allowedExecutors: [] });
  });

  it('accepts the documented minimal Operator entry without granting autopilot', () => {
    const policy = { autonomyLevel: 'A1', allowedExecutors: ['claude', 'codex'] };
    expect(parseProjects({ softwareagents: policy })).toEqual({ softwareagents: policy });
  });
});
