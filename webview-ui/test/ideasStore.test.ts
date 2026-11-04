import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdeasSnapshot, SubmitIdeaResult } from '../../core/src/messages.js';
import type { MessageTransport } from '../../core/src/transport.js';
import {
  applyIdeaResult,
  applyIdeasSnapshot,
  beginIdeaSubmit,
  emptyIdeasStore,
  getIdeasStore,
  ideaDialogState,
  ideaErrorText,
  invalidateIdeas,
  requestIdeas,
  sendIdea,
  setIdeasStore,
} from '../src/office/ideasStore.js';

const snapshot: IdeasSnapshot = {
  type: 'ideasSnapshot',
  requestId: 'read',
  projectId: 'P',
  canSubmit: true,
  errorCode: null,
  ideas: [],
};
const saved: SubmitIdeaResult = {
  type: 'submitIdeaResult',
  requestId: 'submit',
  projectId: 'P',
  status: 'saved',
  errorCode: null,
  idea: {
    key: 'FEAT-001',
    command:
      'pixel-agents feature run FEAT-001 --request .softwareagents/ideas/P/FEAT-001.md --confirm',
  },
};
const ready = () => ({ ...emptyIdeasStore(), requestId: 'read', snapshot });
beforeEach(() => setIdeasStore(emptyIdeasStore()));

describe('SA-109 dialog state without DOM', () => {
  it('shows loading, editing, saving and saved only on correlated confirmation', () => {
    expect(ideaDialogState(emptyIdeasStore(), true)).toBe('loading');
    const editable = applyIdeasSnapshot({ ...emptyIdeasStore(), requestId: 'read' }, snapshot);
    expect(ideaDialogState(editable, true)).toBe('editing');
    const pending = beginIdeaSubmit(editable, 'submit');
    expect(ideaDialogState(pending, true)).toBe('saving');
    expect(beginIdeaSubmit(pending, 'second')).toBe(pending);
    expect(applyIdeaResult(pending, { ...saved, requestId: 'old' })).toBe(pending);
    expect(applyIdeaResult(pending, { ...saved, projectId: 'Q' })).toBe(pending);
    const complete = applyIdeaResult(pending, saved);
    expect(ideaDialogState(complete, true)).toBe('saved');
    expect(complete.snapshot?.ideas).toEqual([saved.idea]);
    expect(complete.pending).toBeNull();
    expect(applyIdeaResult(complete, saved)).toBe(complete);
  });

  it('explains permission and Project preparation failures and permits no submission', () => {
    for (const code of [
      'denied',
      'no_project',
      'missing_manifest',
      'invalid_manifest',
      'unsupported_adapter',
    ] as const) {
      const store = { ...ready(), snapshot: { ...snapshot, canSubmit: false, errorCode: code } };
      expect(ideaDialogState(store, true)).toBe('disabled');
      expect(beginIdeaSubmit(store, 'submit')).toBe(store);
      expect(ideaErrorText(code)).toBeTruthy();
    }
    expect(ideaErrorText('missing_manifest')).toContain('.softwareagents/project.yaml');
    expect(ideaErrorText('denied')).toContain('token');
    expect(ideaErrorText('unsupported_adapter')).toContain('standalone');
  });

  it('shows validation errors, offline, and uncertain outcomes without replay', () => {
    const pending = beginIdeaSubmit(ready(), 'submit');
    expect(ideaDialogState(ready(), false)).toBe('offline');
    for (const errorCode of ['empty_text', 'too_large', 'unsafe_storage'] as const) {
      const failed = applyIdeaResult(pending, {
        ...saved,
        status: 'rejected',
        idea: null,
        errorCode,
      });
      expect(ideaDialogState(failed, true)).toBe('error');
      expect(failed.snapshot?.ideas).toEqual([]);
    }
    const disconnected = invalidateIdeas(pending);
    expect(ideaDialogState(disconnected, true)).toBe('uncertain');
    expect(applyIdeaResult(disconnected, saved)).toBe(disconnected);
    expect(beginIdeaSubmit(disconnected, 'retry')).toBe(disconnected);
    expect(
      ideaDialogState(applyIdeaResult(pending, { ...saved, errorCode: 'audit_failed' }), true),
    ).toBe('saved');
  });

  it('drops stale reads and invalidates prior Project results', () => {
    const store = ready();
    expect(applyIdeasSnapshot(store, { ...snapshot, requestId: 'obsolete' })).toBe(store);
    const switched = applyIdeasSnapshot(beginIdeaSubmit(store, 'submit'), {
      ...snapshot,
      projectId: 'Q',
    });
    expect(switched.pending).toBeNull();
    expect(switched.result).toBeNull();
    expect(switched.uncertain).toBe(true);
    expect(switched.snapshot?.ideas).toEqual([]);
  });

  it('sends the literal text once and never accepts a client-selected feature id', () => {
    const send = vi.fn();
    const transport = { state: 'connected', send } as unknown as MessageTransport;
    setIdeasStore(ready());
    const text = 'Quiero <script>alert(1)</script> $(sin ejecutar)';
    sendIdea(text, transport);
    sendIdea(text, transport);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toEqual({
      type: 'submitIdea',
      projectId: 'P',
      requestId: getIdeasStore().pending!.requestId,
      text,
    });
    expect(Object.keys(send.mock.calls[0][0]).sort()).toEqual([
      'projectId',
      'requestId',
      'text',
      'type',
    ]);
  });

  it('catches a socket close between checking connectivity and sending', () => {
    const send = vi.fn(() => {
      throw new Error('closed');
    });
    setIdeasStore(ready());
    sendIdea('idea', { state: 'connected', send } as unknown as MessageTransport);
    expect(getIdeasStore().uncertain).toBe(true);
    expect(getIdeasStore().pending).toBeNull();
    expect(send).toHaveBeenCalledOnce();
    requestIdeas({ send: vi.fn() } as unknown as MessageTransport);
    expect(getIdeasStore().uncertain).toBe(true);
  });
});
