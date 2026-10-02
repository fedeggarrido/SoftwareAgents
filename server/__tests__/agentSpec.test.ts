import { describe, expect, it } from 'vitest';

import * as schema from '../../core/schemas/agent-spec.schema.json';
import type { AgentSpec } from '../../core/src/agentSpec.js';
import { compileSchema, SchemaValidationError, validateSchema } from '../src/schemaValidation.js';

const validate = compileSchema<AgentSpec>(schema);

// Adapted from docs/research/softwareagents-deep-research-report.md, Plantilla AgentSpec:
// omit deferred knowledge/referents/tools/memory, add department/context, use a v1alpha1 profile.
function architect(): AgentSpec {
  return {
    apiVersion: 'softwareagents.io/v1alpha1',
    kind: 'AgentSpec',
    metadata: {
      id: 'architect',
      version: '1.0.0',
      displayName: 'Architect / Tech Lead',
      department: 'engineering',
    },
    identity: {
      role: 'architect',
      mission:
        'Diseñar la solución técnica más sencilla que satisfaga correctamente las necesidades del producto y permita evolucionar.',
      principles: [
        'Challenge assumptions, not people',
        'Prefer simplicity over speculative abstraction',
        'Reversible decisions should be fast',
        'Critical decisions require evidence',
        'Adopt mature tools before building equivalents',
      ],
      antiPatterns: [
        'architecture astronautics',
        'technology for prestige',
        'premature microservices',
        'blind obedience',
      ],
    },
    outputs: ['TechnicalDesign', 'ADR', 'TaskDAG'],
    permissions: { profile: 'brain_write' },
    modelPolicy: { capabilityClass: 'high_reasoning', fallbackAllowed: true },
    context: { brainPaths: ['architecture', 'decisions', 'features'] },
    gates: { mayBlock: ['severe_architectural_risk', 'data_loss_risk', 'unsafe_security_design'] },
    escalation: {
      humanRequired: [
        'strategic_stack_change',
        'major_recurring_cost',
        'unresolved_product_technical_conflict',
      ],
    },
  };
}

function objectLocations(value: Record<string, unknown>): Record<string, unknown>[] {
  return [
    value,
    ...Object.values(value).flatMap((child) =>
      child !== null && typeof child === 'object' && !Array.isArray(child)
        ? objectLocations(child as Record<string, unknown>)
        : [],
    ),
  ];
}

describe('AgentSpec v1alpha1', () => {
  it('validates the trimmed Architect template without mutating it', () => {
    const value = architect();
    const before = structuredClone(value);
    expect(validateSchema(validate, value)).toBe(value);
    expect(value).toEqual(before);
  });

  it.each(['read_only', 'brain_write', 'branch_write'] as const)(
    'accepts profile %s',
    (profile) => {
      const value = architect();
      value.permissions.profile = profile;
      expect(validate(value)).toBe(true);
    },
  );

  it.each(['model', 'models', 'autonomyLevel', 'unknown'])(
    'rejects %s at every object level',
    (field) => {
      const count = objectLocations(architect() as unknown as Record<string, unknown>).length;
      for (let index = 0; index < count; index++) {
        const value = architect();
        objectLocations(value as unknown as Record<string, unknown>)[index][field] = 'forbidden';
        expect(() => validateSchema(validate, value)).toThrow(SchemaValidationError);
      }
    },
  );

  it.each([
    'claude-sonnet-4',
    'GPT-5',
    'o-reasoning',
    'o3',
    'sonnet',
    'OPUS',
    'Haiku',
    'vendor/gpt-5',
    'use claude-opus-4',
  ])('rejects model identifier %s in every text field', (id) => {
    const visit = (value: unknown, path: (string | number)[] = []): (string | number)[][] => {
      if (typeof value === 'string') return [path];
      if (value !== null && typeof value === 'object')
        return Object.entries(value).flatMap(([key, child]) => visit(child, [...path, key]));
      return [];
    };
    for (const path of visit(architect())) {
      const value = architect();
      let target = value as unknown as Record<string, unknown>;
      for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
      target[path.at(-1)!] = id;
      expect(validate(value), path.join('/')).toBe(false);
    }
  });

  it.each(['1.0.0', '0.1.0-alpha.1+build.42'])('accepts SemVer %s', (version) => {
    const value = architect();
    value.metadata.version = version;
    expect(validate(value)).toBe(true);
  });

  it.each(['1', 'v1.0.0', '01.0.0', '1.0.0-01', '1.0.0+', '1.0.0\n'])(
    'rejects malformed SemVer %s',
    (version) => {
      const value = architect();
      value.metadata.version = version;
      expect(validate(value)).toBe(false);
    },
  );

  it('requires every declared field at every object level', () => {
    const original = architect() as unknown as Record<string, unknown>;
    objectLocations(original).forEach((object, index) => {
      for (const key of Object.keys(object)) {
        const value = architect() as unknown as Record<string, unknown>;
        delete objectLocations(value)[index][key];
        expect(validate(value), key).toBe(false);
      }
    });
  });

  it('rejects deferred sections, invalid profiles, coercion and empty text', () => {
    for (const field of ['referents', 'projectSources', 'tools', 'memory']) {
      expect(validate({ ...architect(), [field]: [] })).toBe(false);
    }
    expect(validate({ ...architect(), permissions: { profile: 'architect' } })).toBe(false);
    expect(
      validate({
        ...architect(),
        modelPolicy: { capabilityClass: 'high_reasoning', fallbackAllowed: 'true' },
      }),
    ).toBe(false);
    expect(validate({ ...architect(), context: { brainPaths: [' '] } })).toBe(false);
    expect(validate({ ...architect(), outputs: ['ADR', 'ADR'] })).toBe(false);
  });

  it('allows empty lists for roles without corresponding declarations', () => {
    const value = architect();
    value.identity.principles = [];
    value.identity.antiPatterns = [];
    value.outputs = [];
    value.context.brainPaths = [];
    value.gates.mayBlock = [];
    value.escalation.humanRequired = [];
    expect(validate(value)).toBe(true);
  });
});
