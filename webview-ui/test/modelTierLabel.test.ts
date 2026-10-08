import { expect, it } from 'vitest';

import {
  clearAgentRole,
  getAgentRole,
  modelTierLabel,
  setAgentRole,
} from '../src/office/toolUtils.js';

it('shows only a known historical model tier; replaces and clears it with the role', () => {
  expect(modelTierLabel(undefined)).toBeUndefined();
  setAgentRole(84, {
    label: 'DEV',
    department: 'Ingeniería',
    tier: 'standard',
    model: 'test-standard-model',
    effort: 'medium',
  });
  expect(modelTierLabel(getAgentRole(84))).toBe('standard · test-standard-model');
  setAgentRole(84, { label: 'DEV', department: 'Ingeniería' });
  expect(modelTierLabel(getAgentRole(84))).toBeUndefined();
  clearAgentRole(84);
  expect(getAgentRole(84)).toBeUndefined();
});
