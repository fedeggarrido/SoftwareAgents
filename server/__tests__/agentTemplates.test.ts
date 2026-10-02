import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import * as schema from '../../core/schemas/agent-spec.schema.json';
import type { AgentSpec } from '../../core/src/agentSpec.js';
import { compileSchema, validateSchema } from '../src/schemaValidation.js';

const directory = new URL('../../agents/templates/', import.meta.url);
const validate = compileSchema<AgentSpec>(schema);
const roles = [
  { id: 'requirements-analyst', profile: 'brain_write', outputs: ['FeatureSpec'] },
  { id: 'architect', profile: 'brain_write', outputs: ['TechnicalDesign', 'ADR', 'TaskDAG'] },
  { id: 'developer', profile: 'branch_write', outputs: ['commits', 'tests'] },
  { id: 'reviewer', profile: 'read_only', outputs: ['ReviewReport'] },
  { id: 'qa', profile: 'read_only', outputs: ['TestReport'] },
] as const;

describe('platform AgentSpec templates', () => {
  it('ships exactly the five vertical slice roles', () => {
    expect(readdirSync(directory).sort()).toEqual(roles.map(({ id }) => id + '.yaml').sort());
  });

  it.each(roles)(
    'validates $id and preserves its permission boundary',
    ({ id, profile, outputs }) => {
      const value: unknown = parse(readFileSync(new URL(id + '.yaml', directory), 'utf8'));
      const spec = validateSchema(validate, value);
      expect(spec.metadata.id).toBe(id);
      expect(spec.identity.role).toBe(id);
      expect(spec.permissions.profile).toBe(profile);
      expect(spec.outputs).toEqual(outputs);
      expect(spec.escalation.humanRequired).toEqual(
        expect.arrayContaining([
          'irreversible_or_high_risk_decision',
          'merge_pr',
          'touch_protected_path',
          'use_new_secret',
          'change_autonomy',
          'permission_expansion',
        ]),
      );
      if (profile === 'read_only') {
        expect(spec.identity.principles.join(' ')).toContain('never edit project files');
        expect(spec.identity.principles.join(' ')).toContain('Execution results');
      }
    },
  );
});
