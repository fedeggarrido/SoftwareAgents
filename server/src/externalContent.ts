import Ajv from 'ajv';

/** JSON-serializable taint: survives caches, structuredClone and executor snapshots. */
export interface UntrustedExternalText {
  kind: 'untrusted-external-text';
  origin: 'web' | 'paper' | 'book' | 'reddit' | 'issue' | 'document' | 'capture' | 'brief';
  text: string;
}

export function externalText(
  origin: UntrustedExternalText['origin'],
  text: string,
): UntrustedExternalText {
  return { kind: 'untrusted-external-text', origin, text };
}

export const EXTERNAL_HANDOFF_TEXT_CHARS = 240;
export const EXTERNAL_HANDOFF_ITEMS = 12;
/** Quotes, bibliography, URLs and model-authored instructions are deliberately absent. */
export const EXTERNAL_HANDOFF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'facts', 'insufficientEvidence'],
  properties: {
    kind: { const: 'external-reader-result' },
    insufficientEvidence: { type: 'boolean' },
    facts: {
      type: 'array',
      maxItems: EXTERNAL_HANDOFF_ITEMS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'confidence'],
        properties: {
          text: { type: 'string', maxLength: EXTERNAL_HANDOFF_TEXT_CHARS },
          confidence: { enum: ['low', 'medium', 'high'] },
        },
      },
    },
  },
} as const;
export interface ExternalReaderResult {
  kind: 'external-reader-result';
  facts: { text: string; confidence: 'low' | 'medium' | 'high' }[];
  insufficientEvidence: boolean;
}
const validate = new Ajv({ strict: true }).compile(EXTERNAL_HANDOFF_SCHEMA);
export function validateExternalReaderResult(value: unknown): ExternalReaderResult {
  if (!validate(value)) throw new Error('Invalid external reader result');
  return structuredClone(value) as ExternalReaderResult;
}

/** Inspect serialized JSON too: briefs and Brain artifacts often embed JSON in strings.
 * This is provenance enforcement, not a detector for malicious natural language. */
// Fences must start a line: diff context/added lines (' ', '+', '-') never open one.
const FENCED_JSON = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)^```/gm;

export function containsExternalContent(value: unknown): boolean {
  if (typeof value === 'string') {
    // Structural only: a diff or source file that merely mentions the marker (e.g. while
    // developing this module) is not external content. Whole-string JSON and fenced JSON
    // blocks (how Markdown artifacts embed data) are parsed and inspected.
    const candidates = [value, ...[...value.matchAll(FENCED_JSON)].map((m) => m[1])];
    return candidates.some((candidate) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        return false; // Not JSON: plain text carries no runtime provenance.
      }
      return typeof parsed !== 'string' && containsExternalContent(parsed);
    });
  }
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsExternalContent);
  const object = value as Record<string, unknown>;
  if (
    object.kind === 'untrusted-external-text' ||
    object.provenance === 'untrusted-external' ||
    // Legacy SourceItems also remain tainted before provenance was introduced.
    (typeof object.excerpt === 'string' && typeof object.contentHash === 'string')
  )
    return true;
  // An invalid reader result is untrusted, never a reason to stop inspecting siblings.
  if (object.kind === 'external-reader-result') {
    try {
      validateExternalReaderResult(object);
    } catch {
      return true;
    }
  }
  return Object.values(object).some(containsExternalContent);
}
