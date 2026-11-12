import { describe, expect, it } from 'vitest';

import type { GithubHostingOptions } from '../../core/src/messages.js';
import { githubWizardReducer, initialGithubWizard } from '../src/office/githubHostingWizard.js';

const options: GithubHostingOptions = {
  type: 'githubHostingOptions',
  requestId: 'load',
  projectId: 'tienda',
  login: 'operador',
  owners: ['operador', 'organizacion'],
  owner: 'operador',
  name: 'tienda',
  visibility: 'private',
  confirmationId: 'one-use',
  operation: 'create',
  errorCode: null,
};
function configured() {
  return githubWizardReducer(
    githubWizardReducer(initialGithubWizard(), { type: 'load', requestId: 'load' }),
    { type: 'reply', message: options },
  );
}
describe('SA-146 GitHub wizard', () => {
  it('defaults to private and requires review before publishing', () => {
    const state = configured();
    expect(state.draft).toEqual({ name: 'tienda', owner: 'operador', visibility: 'private' });
    expect(githubWizardReducer(state, { type: 'publish', requestId: 'early' })).toBe(state);
    const edited = githubWizardReducer(state, {
      type: 'edit',
      draft: { owner: 'organizacion', visibility: 'public' },
    });
    const review = githubWizardReducer(edited, { type: 'review' });
    expect(review.step).toBe('confirm');
    expect(review.draft).toMatchObject({ owner: 'organizacion', visibility: 'public' });
    const publishing = githubWizardReducer(review, { type: 'publish', requestId: 'publish' });
    expect(publishing.step).toBe('publishing');
    expect(githubWizardReducer(publishing, { type: 'publish', requestId: 'duplicate' })).toBe(
      publishing,
    );
  });
  it('invalidates approval on failure and requires fetching and reviewing a fresh confirmation', () => {
    const publishing = githubWizardReducer(githubWizardReducer(configured(), { type: 'review' }), {
      type: 'publish',
      requestId: 'publish',
    });
    const failed = githubWizardReducer(publishing, {
      type: 'reply',
      message: {
        type: 'githubHostingResult',
        requestId: 'publish',
        projectId: 'tienda',
        status: 'rejected',
        errorCode: 'name_taken',
      },
    });
    expect(failed.options).toBeNull();
    expect(githubWizardReducer(failed, { type: 'publish', requestId: 'retry' })).toBe(failed);
    const loading = githubWizardReducer(failed, { type: 'load', requestId: 'retry' });
    const refreshed = githubWizardReducer(loading, {
      type: 'reply',
      message: { ...options, requestId: 'retry', confirmationId: 'fresh' },
    });
    expect(refreshed.step).toBe('configure');
    expect(githubWizardReducer(refreshed, { type: 'publish', requestId: 'retry' })).toBe(refreshed);
  });
  it('locks the destination during push recovery', () => {
    const loading = githubWizardReducer(initialGithubWizard(), { type: 'load', requestId: 'load' });
    const recovery = githubWizardReducer(loading, {
      type: 'reply',
      message: {
        ...options,
        operation: 'push',
        owner: 'organizacion',
        name: 'existente',
        visibility: 'public',
      },
    });
    expect(recovery.draft).toEqual({
      owner: 'organizacion',
      name: 'existente',
      visibility: 'public',
    });
    expect(githubWizardReducer(recovery, { type: 'edit', draft: { name: 'otro' } })).toBe(recovery);
  });
  it('retains the chosen organization, name and visibility when reloading after a failure', () => {
    const edited = githubWizardReducer(configured(), {
      type: 'edit',
      draft: { owner: 'organizacion', name: 'nuevo-nombre', visibility: 'public' },
    });
    const loading = githubWizardReducer(edited, { type: 'load', requestId: 'reload' });
    const refreshed = githubWizardReducer(loading, {
      type: 'reply',
      message: { ...options, requestId: 'reload', confirmationId: 'fresh' },
    });
    expect(refreshed.draft).toEqual(edited.draft);
    expect(refreshed.step).toBe('configure');
  });
  it('discards late replies and loses the capability on disconnect', () => {
    const state = configured();
    expect(githubWizardReducer(state, { type: 'reply', message: options })).toBe(state);
    const pending = githubWizardReducer(githubWizardReducer(state, { type: 'review' }), {
      type: 'publish',
      requestId: 'publish',
    });
    const lost = githubWizardReducer(pending, { type: 'lost' });
    expect(lost.step).toBe('uncertain');
    expect(lost.options).toBeNull();
    expect(githubWizardReducer(lost, { type: 'publish', requestId: 'retry' })).toBe(lost);
  });
  it('rejects invalid names and owners before showing confirmation', () => {
    for (const draft of [{ name: '' }, { name: '--public' }, { owner: 'intruso' }]) {
      const state = githubWizardReducer(configured(), { type: 'edit', draft });
      expect(githubWizardReducer(state, { type: 'review' })).toBe(state);
    }
  });
});
