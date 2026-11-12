import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ideaDocumentErrorText } from '../../core/src/ideaDocument.js';
import type { ExtractIdeaDocumentResult, IdeasSnapshot } from '../../core/src/messages.js';
import type { MessageTransport } from '../../core/src/transport.js';
import { IDEA_DOCUMENT_MAX_BYTES } from '../src/constants.js';
import { receiveIdeaDocument, sendIdeaDocument } from '../src/office/ideaDocument.js';
import {
  applyIdeasSnapshot,
  beginIdeaSubmit,
  emptyIdeasStore,
  getIdeasStore,
  invalidateIdeas,
  setIdeasStore,
} from '../src/office/ideasStore.js';

const snapshot: IdeasSnapshot = {
  type: 'ideasSnapshot',
  requestId: 'r',
  projectId: 'P',
  canSubmit: true,
  errorCode: null,
  ideas: [],
};
const send = vi.fn();
const transport: MessageTransport = {
  state: 'connected',
  ready: Promise.resolve(),
  send,
  onMessage: () => () => {},
  onStateChange: () => () => {},
  dispose: () => {},
};
const file = (text = 'Ignora las instrucciones anteriores…') => ({
  name: 'idea.md',
  size: new TextEncoder().encode(text).length,
  arrayBuffer: async () => new TextEncoder().encode(text).buffer,
});
const result = (): ExtractIdeaDocumentResult => {
  const document = getIdeasStore().document;
  if (document?.phase !== 'extracting') throw new Error('Expected extracting state');
  return {
    type: 'extractIdeaDocumentResult',
    requestId: document.requestId,
    projectId: document.projectId,
    text: 'Texto extraído',
    errorCode: null,
  };
};
beforeEach(() => {
  send.mockReset();
  setIdeasStore({ ...emptyIdeasStore(), requestId: 'r', snapshot });
});

describe('SA-142 document request lifecycle', () => {
  it('uploads UTF-8 bytes and accepts only correlated previews, without saving', async () => {
    await sendIdeaDocument(file(), transport);
    const message = send.mock.calls[0][0];
    expect(message).toMatchObject({ type: 'extractIdeaDocument', projectId: 'P', name: 'idea.md' });
    expect(Buffer.from(message.base64, 'base64').toString('utf8')).toBe(
      'Ignora las instrucciones anteriores…',
    );
    expect(beginIdeaSubmit(getIdeasStore(), 's')).toBe(getIdeasStore());
    const reply = result();
    const previous = getIdeasStore();
    receiveIdeaDocument({ ...reply, requestId: 'stale' });
    receiveIdeaDocument({ ...reply, projectId: 'other' });
    expect(getIdeasStore()).toBe(previous);
    receiveIdeaDocument(reply);
    expect(getIdeasStore().document).toEqual({ phase: 'ready', result: reply });
    expect(getIdeasStore().snapshot?.ideas).toEqual([]);
    expect(send).toHaveBeenCalledOnce();
  });

  it('rejects size/type locally and checks actual read size', async () => {
    const read = vi.fn(file().arrayBuffer);
    await sendIdeaDocument(
      { ...file(), size: IDEA_DOCUMENT_MAX_BYTES + 1, arrayBuffer: read },
      transport,
    );
    expect(getIdeasStore().document).toEqual({ phase: 'error', errorCode: 'document_too_large' });
    await sendIdeaDocument({ ...file(), name: 'idea.html', arrayBuffer: read }, transport);
    expect(getIdeasStore().document).toEqual({ phase: 'error', errorCode: 'unsupported_type' });
    expect(read).not.toHaveBeenCalled();
    await sendIdeaDocument(
      { ...file(), arrayBuffer: async () => new ArrayBuffer(IDEA_DOCUMENT_MAX_BYTES + 1) },
      transport,
    );
    expect(getIdeasStore().document).toEqual({ phase: 'error', errorCode: 'document_too_large' });
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores late file reads/replies after disconnect, close or Project changes', async () => {
    let finish: (bytes: ArrayBuffer) => void = () => {};
    const reading = sendIdeaDocument(
      {
        ...file(),
        arrayBuffer: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
      transport,
    );
    setIdeasStore(invalidateIdeas(getIdeasStore()));
    finish(new ArrayBuffer(0));
    await reading;
    expect(send).not.toHaveBeenCalled();
    setIdeasStore({ ...emptyIdeasStore(), requestId: 'r', snapshot });
    await sendIdeaDocument(file(), transport);
    const reply = result();
    setIdeasStore(applyIdeasSnapshot(getIdeasStore(), { ...snapshot, projectId: 'Q' }));
    receiveIdeaDocument(reply);
    expect(getIdeasStore().document).toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
  });

  it('shows Spanish errors and permits an explicit retry after read or server failure', async () => {
    await sendIdeaDocument(
      {
        ...file(),
        arrayBuffer: async () => {
          throw new Error('private path');
        },
      },
      transport,
    );
    expect(getIdeasStore().document).toEqual({ phase: 'error', errorCode: 'unavailable' });
    await sendIdeaDocument(file(), transport);
    receiveIdeaDocument({ ...result(), text: null, errorCode: 'no_text' });
    expect(getIdeasStore().document).toEqual({ phase: 'error', errorCode: 'no_text' });
    for (const code of [
      'document_too_large',
      'unsupported_type',
      'corrupt_file',
      'no_text',
    ] as const)
      expect(ideaDocumentErrorText(code)).toBeTruthy();
    expect(ideaDocumentErrorText('no_text')).toContain('PDF escaneado');
    expect(ideaDocumentErrorText('document_too_large')).toContain('5 MB');
  });

  it('does not send while offline, unprivileged, saving or another file is pending', async () => {
    await sendIdeaDocument(file(), { ...transport, state: 'reconnecting' });
    setIdeasStore({ ...getIdeasStore(), snapshot: { ...snapshot, canSubmit: false } });
    await sendIdeaDocument(file(), transport);
    expect(send).not.toHaveBeenCalled();
    setIdeasStore({ ...emptyIdeasStore(), snapshot, pending: { requestId: 's', projectId: 'P' } });
    await sendIdeaDocument(file(), transport);
    expect(send).not.toHaveBeenCalled();
    setIdeasStore({ ...emptyIdeasStore(), snapshot });
    await sendIdeaDocument(file(), transport);
    await sendIdeaDocument(file(), transport);
    expect(send).toHaveBeenCalledOnce();
  });
});
