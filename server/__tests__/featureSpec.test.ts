import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

import * as schema from '../../core/schemas/feature-spec.schema.json';
import type { FeatureSpec } from '../../core/src/featureSpec.js';
import { loadFeatureSpec } from '../src/featureSpec.js';
import { compileSchema, SchemaValidationError, validateSchema } from '../src/schemaValidation.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = (name: string) => path.join(root, 'server/__tests__/fixtures/brain', name);
const valid = () => loadFeatureSpec(fixture('feature-spec.valid.yaml'));
const validate = compileSchema<FeatureSpec>(schema);

describe('FeatureSpec v1alpha1', () => {
  it('loads the valid fixture and reusable template', () => {
    expect(valid()).toMatchObject({ key: 'FEAT-001', acceptance: [{ id: 'AC-001' }] });
    expect(loadFeatureSpec(path.join(root, '.softwareagents/templates/FEATURE_SPEC.yaml'))).toEqual(
      valid(),
    );
  });

  it('reports the file and malformed key field', () => {
    const file = fixture('feature-spec.invalid-key.yaml');
    expect(() => loadFeatureSpec(file)).toThrow(`${file}: /key: must match pattern`);
  });

  it('reports every missing acceptance condition with its field path', () => {
    const file = fixture('feature-spec.invalid-acceptance.yaml');
    try {
      loadFeatureSpec(file);
      expect.fail('Invalid acceptance must fail');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      for (const field of ['given', 'when', 'then']) {
        expect((error as SchemaValidationError).errors).toContain(
          `${file}: /acceptance/0/${field}: must have required property '${field}'`,
        );
      }
    }
  });

  it.each(['draft', 'proposed', 'approved', 'superseded'] as const)('accepts %s', (status) => {
    expect(validate({ ...valid(), status })).toBe(true);
  });

  it('rejects unknown fields, wrong versions, statuses, IDs, empty text and coercion', () => {
    const spec = valid();
    for (const value of [
      { ...spec, unknown: true },
      { ...spec, apiVersion: 'v2' },
      { ...spec, kind: 'AgentSpec' },
      { ...spec, version: '1' },
      { ...spec, status: 'accepted' },
      { ...spec, actors: [1] },
      { ...spec, goal: ' ' },
      { ...spec, links: { ...spec.links, command: 'run' } },
      { ...spec, acceptance: [] },
      { ...spec, acceptance: [{ ...spec.acceptance[0], id: 'AC-1' }] },
      { ...spec, acceptance: [{ ...spec.acceptance[0], then: ' ' }] },
      { ...spec, acceptance: [{ ...spec.acceptance[0], unknown: true }] },
    ]) {
      expect(() => validateSchema(validate, value)).toThrow(SchemaValidationError);
    }
    expect(spec).toEqual(valid());
  });

  it('requires every top-level field', () => {
    for (const field of Object.keys(valid())) {
      const value: Record<string, unknown> = { ...valid() };
      delete value[field];
      expect(() => validateSchema(validate, value)).toThrow(`/${field}:`);
    }
  });

  it('reports missing files without substituting defaults', () => {
    expect(() => loadFeatureSpec(fixture('missing.yaml'))).toThrow(/ENOENT/);
  });

  it.each(['feature-spec.invalid-duplicate.yaml', 'feature-spec.invalid-yaml.yaml'])(
    'rejects YAML parsing errors in %s with the source file',
    (name) => {
      const file = fixture(name);
      expect(() => loadFeatureSpec(file)).toThrow(SchemaValidationError);
      expect(() => loadFeatureSpec(file)).toThrow(`${file}: /:`);
    },
  );

  it('keeps ADR-0002 and ADR-0003 aligned with the template', () => {
    const template = fs.readFileSync(path.join(root, '.softwareagents/templates/ADR.md'), 'utf8');
    const headings = template.match(/^## .+$/gm)!;
    for (const name of [
      '0002-evolucion-incremental-del-fork.md',
      '0003-workstore-sqlite-local.md',
    ]) {
      const source = fs.readFileSync(path.join(root, 'docs/adr', name), 'utf8');
      const frontMatter = parseDocument(source.split('---')[1]).toJS();
      expect(frontMatter).toEqual({
        Status: 'Proposed',
        Date: '2026-10-02',
        Owner: 'Fede',
        'Related Feature': [],
        Supersedes: [],
      });
      for (const heading of headings) expect(source).toContain(heading);
    }
  });
});
