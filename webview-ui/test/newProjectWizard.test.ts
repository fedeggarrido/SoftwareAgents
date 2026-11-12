import { describe, expect, it } from 'vitest';

import type { NewProjectValidation } from '../../core/src/messages.js';
import {
  canContinueProjectName,
  initialProjectWizard,
  projectWizardReducer,
} from '../src/office/newProjectWizard.js';

const ready: NewProjectValidation = {
  type: 'newProjectValidation',
  requestId: 'validate',
  path: '/projects/tienda',
  projectId: null,
  hosting: 'local',
  status: 'ready',
  errorCode: null,
};
function named() {
  const loading = projectWizardReducer(initialProjectWizard(), {
    type: 'begin',
    requestId: 'options',
    operation: 'options',
  });
  return projectWizardReducer(loading, {
    type: 'reply',
    message: {
      type: 'newProjectOptions',
      requestId: 'options',
      proposals: ['tienda', 'tienda-barrio'],
      defaultParent: '/projects',
      errorCode: null,
    },
  });
}
function validated() {
  const path = projectWizardReducer(named(), { type: 'next' });
  const pending = projectWizardReducer(path, {
    type: 'begin',
    requestId: 'validate',
    operation: 'validate',
  });
  return projectWizardReducer(pending, { type: 'reply', message: ready });
}

describe('SA-157 wizard state machine', () => {
  it('advances name → validated path → hosting → confirmation → human creation', () => {
    const name = named();
    expect(name.step).toBe('name');
    expect(name.draft).toMatchObject({ name: 'tienda', parentPath: '/projects', hosting: 'local' });
    const path = projectWizardReducer(name, { type: 'next' });
    expect(path.step).toBe('path');
    expect(projectWizardReducer(path, { type: 'next' })).toBe(path);
    const hosting = projectWizardReducer(validated(), {
      type: 'edit',
      draft: { hosting: 'github_private' },
    });
    const confirm = projectWizardReducer(hosting, { type: 'next' });
    expect(confirm.step).toBe('confirm');
    expect(confirm.draft.hosting).toBe('github_private');
    const creating = projectWizardReducer(confirm, {
      type: 'begin',
      operation: 'create',
      requestId: 'create',
    });
    expect(creating.step).toBe('creating');
    expect(
      projectWizardReducer(creating, {
        type: 'begin',
        operation: 'create',
        requestId: 'duplicate',
      }),
    ).toBe(creating);
    const created = projectWizardReducer(creating, {
      type: 'reply',
      message: {
        ...ready,
        type: 'newProjectResult',
        requestId: 'create',
        projectId: 'tienda-123',
        status: 'created',
        hosting: 'github_private',
      },
    });
    expect(created.step).toBe('created');
    expect(created.result?.hosting).toBe('github_private');
  });
  it('rejects invalid names, correlates replies and discards validation after editing the path', () => {
    expect(canContinueProjectName('')).toBe(false);
    expect(canContinueProjectName('con')).toBe(false);
    const name = named();
    expect(
      projectWizardReducer(name, { type: 'begin', requestId: 'early', operation: 'create' }),
    ).toBe(name);
    const path = projectWizardReducer(named(), { type: 'next' });
    expect(projectWizardReducer(path, { type: 'reply', message: ready })).toBe(path);
    const edited = projectWizardReducer(projectWizardReducer(validated(), { type: 'back' }), {
      type: 'edit',
      draft: { parentPath: '/elsewhere' },
    });
    expect(edited.validation).toBeNull();
    expect(edited.step).toBe('path');
  });
  it('keeps folder errors on the path step and lets the human choose explicit adoption', () => {
    const path = projectWizardReducer(named(), { type: 'next' });
    const pending = projectWizardReducer(path, {
      type: 'begin',
      requestId: 'validate',
      operation: 'validate',
    });
    const rejected = projectWizardReducer(pending, {
      type: 'reply',
      message: { ...ready, status: 'rejected', errorCode: 'existing_available' },
    });
    expect(rejected.step).toBe('path');
    expect(rejected.draft.folderMode).toBe('create');
    const adopt = projectWizardReducer(rejected, {
      type: 'edit',
      draft: { parentPath: ready.path!, folderMode: 'existing' },
    });
    expect(adopt.draft.folderMode).toBe('existing');
    expect(adopt.validation).toBeNull();
  });
  it('never replays an uncertain creation after timeout or disconnection', () => {
    const confirm = projectWizardReducer(validated(), { type: 'next' });
    const creating = projectWizardReducer(confirm, {
      type: 'begin',
      requestId: 'create',
      operation: 'create',
    });
    const lost = projectWizardReducer(creating, { type: 'lost' });
    expect(lost.step).toBe('uncertain');
    expect(
      projectWizardReducer(lost, { type: 'begin', requestId: 'retry', operation: 'create' }),
    ).toBe(lost);
    expect(
      projectWizardReducer(lost, {
        type: 'reply',
        message: { ...ready, type: 'newProjectResult', status: 'created' },
      }),
    ).toBe(lost);
  });
});
