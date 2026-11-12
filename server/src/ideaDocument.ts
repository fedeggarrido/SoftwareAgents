import * as fs from 'node:fs';
import * as path from 'node:path';

import { ideaDocumentErrorText } from '../../core/src/ideaDocument.js';
import type { ExtractIdeaDocumentResult, IdeaDocumentError } from '../../core/src/messages.js';
import { companyWorkspaceRoot } from './companyControl.js';
import { IDEA_DOCUMENT_MAX_BYTES } from './constants.js';
import { readIdeas } from './featureIdeas.js';
import { featureIngressActor } from './featureIngress.js';

export class IdeaDocumentFailure extends Error {
  constructor(readonly code: IdeaDocumentError) {
    super(ideaDocumentErrorText(code));
  }
}

function requireHuman(): void {
  if (featureIngressActor() !== 'human') throw new IdeaDocumentFailure('denied');
}

function documentType(name: string): string {
  const extension = path.extname(name).toLowerCase();
  if (!['.pdf', '.md', '.txt'].includes(extension))
    throw new IdeaDocumentFailure('unsupported_type');
  return extension;
}

function checkSize(bytes: number): void {
  if (bytes > IDEA_DOCUMENT_MAX_BYTES) throw new IdeaDocumentFailure('document_too_large');
}

/** Bytes only. PDF parsing cannot select a URL, execute PDF scripts or fetch fonts. */
export async function extractIdeaDocument(name: string, bytes: Uint8Array): Promise<string> {
  requireHuman();
  const type = documentType(name);
  checkSize(bytes.byteLength);
  try {
    let text: string;
    if (type === '.pdf') {
      const pdfjs = await import('unpdf')
        .then((module) => module.getResolvedPDFJS())
        .catch(() => {
          throw new IdeaDocumentFailure('unavailable');
        });
      const loading = pdfjs.getDocument({
        data: new Uint8Array(bytes),
        useSystemFonts: false,
        useWorkerFetch: false,
        disableFontFace: true,
        useWasm: false,
        stopAtErrors: true,
        verbosity: 0,
      });
      try {
        const pdf = await loading.promise;
        const pages: string[] = [];
        let size = 0;
        // Sequential pages bound fan-out and preserve paragraph/page breaks.
        for (let number = 1; number <= pdf.numPages; number++) {
          const page = await pdf.getPage(number);
          const content = await page.getTextContent();
          const lines = content.items.flatMap((item) =>
            'str' in item ? [item.str + (item.hasEOL ? '\n' : '')] : [],
          );
          const pageText = lines.join('');
          size += Buffer.byteLength(pageText, 'utf8');
          checkSize(size + pages.length);
          pages.push(pageText);
          page.cleanup();
        }
        text = pages.join('\n');
      } finally {
        await loading.destroy();
      }
    } else {
      // Fatal decoding rejects binary/invalid UTF-8 without silently replacing bytes.
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) throw new IdeaDocumentFailure('corrupt_file');
    }
    if (!text.trim()) throw new IdeaDocumentFailure('no_text');
    return text;
  } catch (error) {
    if (error instanceof IdeaDocumentFailure) throw error;
    throw new IdeaDocumentFailure('corrupt_file');
  }
}

/** Operator-selected paths can be outside the Project. Read at most the limit + one byte. */
export async function readIdeaDocument(file: string): Promise<string> {
  requireHuman();
  documentType(file);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new IdeaDocumentFailure('corrupt_file');
    checkSize(stat.size);
    const bytes = Buffer.alloc(IDEA_DOCUMENT_MAX_BYTES + 1);
    let count = 0;
    let read: number;
    do {
      read = fs.readSync(fd, bytes, count, bytes.length - count, null);
      count += read;
    } while (read && count < bytes.length);
    checkSize(count);
    return await extractIdeaDocument(file, bytes.subarray(0, count));
  } catch (error) {
    if (error instanceof IdeaDocumentFailure) throw error;
    throw new IdeaDocumentFailure('corrupt_file');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Human capability and Project binding precede decoding/parsing. No document is persisted. */
export async function handleIdeaDocumentMessage(
  msg: Record<string, unknown>,
  send: (message: Record<string, unknown>) => void,
  privileged: boolean,
  supported = true,
  root = companyWorkspaceRoot(),
): Promise<void> {
  if (typeof msg.requestId !== 'string' || typeof msg.projectId !== 'string') return;
  const result: ExtractIdeaDocumentResult = {
    type: 'extractIdeaDocumentResult',
    requestId: msg.requestId,
    projectId: msg.projectId,
    text: null,
    errorCode: null,
  };
  try {
    if (!privileged) throw new IdeaDocumentFailure('denied');
    requireHuman();
    if (!supported) throw new IdeaDocumentFailure('unsupported_adapter');
    if (
      Object.keys(msg).some(
        (key) => !['type', 'requestId', 'projectId', 'name', 'base64'].includes(key),
      ) ||
      typeof msg.name !== 'string' ||
      typeof msg.base64 !== 'string'
    )
      throw new IdeaDocumentFailure('invalid_request');
    const snapshot = readIdeas(msg.requestId, privileged, root);
    if (!snapshot.canSubmit) throw new IdeaDocumentFailure('unavailable');
    if (snapshot.projectId !== msg.projectId) throw new IdeaDocumentFailure('unknown_project');
    if (msg.base64.length > Math.ceil(IDEA_DOCUMENT_MAX_BYTES / 3) * 4)
      throw new IdeaDocumentFailure('document_too_large');
    const bytes = Buffer.from(msg.base64, 'base64');
    if (bytes.toString('base64') !== msg.base64) throw new IdeaDocumentFailure('invalid_request');
    result.text = await extractIdeaDocument(msg.name, bytes);
    // Managed-process identity can change while asynchronous extraction is running.
    requireHuman();
  } catch (error) {
    result.text = null;
    result.errorCode = error instanceof IdeaDocumentFailure ? error.code : 'unavailable';
  }
  send({ ...result });
}
