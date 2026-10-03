import { describe, expect, it } from 'vitest';

import { decisionOptions } from '../src/office/decisionOptions.js';

describe('decision choices', () => {
  it('keeps legacy answers unchanged', () => {
    expect(
      decisionOptions({ id: 'legacy', question: 'Choose', status: 'open', options: ['Wait'] }),
    ).toEqual([{ id: 'Wait', label: 'Wait', details: undefined }]);
  });
  it('uses option IDs for answers and carries benefit, cost and risk for display', () => {
    const option = {
      id: 'wait',
      label: 'Wait for review',
      benefit: 'Confidence',
      cost: 'Time',
      risk: 'Delay',
    };
    expect(
      decisionOptions({
        id: 'structured',
        question: 'Choose',
        status: 'open',
        options: ['wait'],
        structuredOptions: [option],
      }),
    ).toEqual([{ id: 'wait', label: 'Wait for review', details: option }]);
  });
});
