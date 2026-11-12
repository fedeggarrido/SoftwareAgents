import type { ExtractIdeaDocumentResult } from '../../../core/src/messages.js';
import type { MessageTransport } from '../../../core/src/transport.js';
import { IDEA_DOCUMENT_MAX_BYTES } from '../constants.js';
import { getIdeasStore, setIdeasStore } from './ideasStore.js';

export interface IdeaDocumentFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

let sequence = 0;

/** File reads and replies must belong to the active request and Project. */
export function receiveIdeaDocument(result: ExtractIdeaDocumentResult): void {
  const store = getIdeasStore();
  const pending = store.document;
  if (
    pending?.phase !== 'extracting' ||
    pending.requestId !== result.requestId ||
    pending.projectId !== result.projectId ||
    store.snapshot?.projectId !== result.projectId
  )
    return;
  setIdeasStore({
    ...store,
    document: result.errorCode
      ? { phase: 'error', errorCode: result.errorCode }
      : { phase: 'ready', result },
  });
}

export async function sendIdeaDocument(
  file: IdeaDocumentFile,
  transport: MessageTransport,
): Promise<void> {
  const store = getIdeasStore();
  if (
    transport.state !== 'connected' ||
    !store.snapshot?.canSubmit ||
    !store.snapshot.projectId ||
    store.pending ||
    store.uncertain ||
    store.document?.phase === 'reading' ||
    store.document?.phase === 'extracting'
  )
    return;
  if (file.size > IDEA_DOCUMENT_MAX_BYTES) {
    setIdeasStore({ ...store, document: { phase: 'error', errorCode: 'document_too_large' } });
    return;
  }
  if (!/\.(pdf|md|txt)$/i.test(file.name)) {
    setIdeasStore({ ...store, document: { phase: 'error', errorCode: 'unsupported_type' } });
    return;
  }
  const requestId = `idea-document-${++sequence}`;
  const projectId = store.snapshot.projectId;
  setIdeasStore({ ...store, document: { phase: 'reading', requestId, projectId } });
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const current = getIdeasStore();
    const pending = current.document;
    if (
      pending?.phase !== 'reading' ||
      pending.requestId !== requestId ||
      current.snapshot?.projectId !== projectId ||
      transport.state !== 'connected'
    )
      return;
    if (bytes.byteLength > IDEA_DOCUMENT_MAX_BYTES) {
      setIdeasStore({ ...current, document: { phase: 'error', errorCode: 'document_too_large' } });
      return;
    }
    // Avoid spreading a multi-megabyte array onto the JS call stack.
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
    setIdeasStore({ ...current, document: { phase: 'extracting', requestId, projectId } });
    transport.send({
      type: 'extractIdeaDocument',
      requestId,
      projectId,
      name: file.name,
      base64: btoa(binary),
    });
  } catch {
    const current = getIdeasStore();
    const pending = current.document;
    if (
      (pending?.phase === 'reading' || pending?.phase === 'extracting') &&
      pending.requestId === requestId
    )
      setIdeasStore({ ...current, document: { phase: 'error', errorCode: 'unavailable' } });
  }
}
