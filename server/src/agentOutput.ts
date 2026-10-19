import { isMap, parseDocument } from 'yaml';

/** Agents asked for a JSON object often wrap it in prose or a ```json fence.
 * Returns the object's text: the whole output when it parses (as JSON, or as a YAML
 * mapping, which callers parse themselves), else the last fenced block that parses,
 * else the last balanced top-level object that parses. The caller still validates
 * the result; this only removes the wrapping. */
export function extractJsonObject(output: string): string {
  const trimmed = output.trim();
  if (parsesAsObject(trimmed) || isYamlMapping(trimmed)) return trimmed;
  const fences = [...output.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  for (const block of fences.reverse()) if (parsesAsObject(block)) return block;
  const candidates = balancedObjects(output);
  for (const candidate of candidates.reverse()) if (parsesAsObject(candidate)) return candidate;
  return output;
}

/** A whole YAML document whose root is a mapping with several keys (a lone
 * `Note: ...` line of prose followed by JSON also parses as a one-key mapping).
 * No alias expansion (no toJS). */
function isYamlMapping(text: string): boolean {
  if (text.startsWith('{')) return false;
  try {
    const doc = parseDocument(text);
    return doc.errors.length === 0 && isMap(doc.contents) && doc.contents.items.length > 1;
  } catch {
    return false;
  }
}

function parsesAsObject(text: string): boolean {
  if (!text.startsWith('{')) return false;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** Top-level `{...}` spans, skipping braces inside JSON strings. */
function balancedObjects(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0) spans.push(text.slice(start, i + 1));
    }
  }
  return spans;
}
