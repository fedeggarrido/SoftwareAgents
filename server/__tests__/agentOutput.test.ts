import { describe, expect, it } from 'vitest';

import { extractJsonObject } from '../src/agentOutput.js';

describe('extractJsonObject', () => {
  it('returns a bare object unchanged', () => {
    expect(extractJsonObject(' {"a":1} ')).toBe('{"a":1}');
  });

  it('strips prose before the object (real Architect output shape)', () => {
    const out =
      'The audit view is a read path. Writing the proposal now.\n{"dag":{"tasks":[]},"x":"}"}';
    expect(JSON.parse(extractJsonObject(out))).toEqual({ dag: { tasks: [] }, x: '}' });
  });

  it('prefers the last parseable ```json fence', () => {
    const out = 'Draft:\n```json\n{"v":1}\n```\nFinal:\n```json\n{"v":2}\n```\nDone.';
    expect(JSON.parse(extractJsonObject(out))).toEqual({ v: 2 });
  });

  it('ignores braces inside strings and picks the last balanced object', () => {
    const out = 'Note {not json} then {"text":"a { b } c","n":{"m":1}} trailing';
    expect(JSON.parse(extractJsonObject(out))).toEqual({ text: 'a { b } c', n: { m: 1 } });
  });

  it('keeps a YAML document with embedded JSON whole, but not a one-key prose line', () => {
    const yaml = 'key: FEAT-001\nstatus: draft\nacceptance: [{"id":"AC-001"}]';
    expect(extractJsonObject(yaml)).toBe(yaml);
    const prose = 'Nota: aquí va la propuesta\n{"dag":{"tasks":[]}}';
    expect(JSON.parse(extractJsonObject(prose))).toEqual({ dag: { tasks: [] } });
  });

  it('leaves non-JSON output for the caller to reject (YAML or arrays)', () => {
    expect(extractJsonObject('key: FEAT-001\nstatus: draft')).toBe('key: FEAT-001\nstatus: draft');
    expect(extractJsonObject('[1,2]')).toBe('[1,2]');
  });
});
