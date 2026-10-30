import { HOOK_INPUT_STRING_MAX_CHARS, MAX_HOOK_BODY_SIZE } from '../../../../constants.js';

/** The server never reads tool_response (a screenshot or long command output) and
 * rejects bodies over MAX_HOOK_BODY_SIZE with 413, which loses the event and leaves the
 * tool looking active in the office. Drop it, then trim long tool_input strings. */
export function hookBody(data: Record<string, unknown>): string {
  const { tool_response: _unused, ...kept } = data;
  let body = JSON.stringify(kept);
  if (Buffer.byteLength(body) <= MAX_HOOK_BODY_SIZE) return body;
  const input = kept.tool_input;
  if (typeof input === 'object' && input !== null) {
    kept.tool_input = Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([k, v]) => [
        k,
        typeof v === 'string' && v.length > HOOK_INPUT_STRING_MAX_CHARS
          ? v.slice(0, HOOK_INPUT_STRING_MAX_CHARS) + '…'
          : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
            ? v
            : '[omitted]',
      ]),
    );
    body = JSON.stringify(kept);
  }
  return body;
}
