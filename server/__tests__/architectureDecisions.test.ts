import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HumanDecision, NewHumanDecision } from '../../core/src/humanDecision.js';
import {
  architectureAnswer,
  assertArchitectureAnswer,
  openArchitectureAlternative,
  requireArchitectureChoice,
  requireArchitectureDecision,
} from '../src/architectureDecisions.js';
import * as ingress from '../src/featureIngress.js';
import { ARCHITECTURE_PROPOSAL_ERROR } from '../src/projectArchitectureConstants.js';
import { SchemaValidationError } from '../src/schemaValidation.js';
import type { FeatureRecord, WorkStore } from '../src/workstore/WorkStore.js';

const choice = {
  kind: 'alternative' as const,
  name: 'Monolito en capas',
  rationale: 'El equipo ya lo conoce',
  alternatives: ['Hexagonal', 'Monolito en capas'],
};
const ADR = 'docs/adr/0007-arquitectura-del-proyecto.md';

function fakeStore(sha = 'spec-sha') {
  const decisions: HumanDecision[] = [];
  const store: Pick<WorkStore, 'getFeature' | 'listDecisions' | 'openOrJoinIdleDecision'> = {
    getFeature: (key: string) =>
      // SAFETY: architectureDecisions reads only git_sha from the feature record.
      key === 'FEAT-001' ? ({ git_sha: sha } as FeatureRecord) : undefined,
    listDecisions: () => decisions,
    openOrJoinIdleDecision: async (input: NewHumanDecision) => {
      // SAFETY: test fake keeps only the fields read by architectureDecisions.
      const decision = { ...input, status: 'open' } as HumanDecision;
      decisions.push(decision);
      return { decision, created: true, added: true };
    },
  };
  return { store, decisions };
}

/** The architect fails validation with the proposal; the runtime turns it into a Decision. */
function proposalError(sha = 'spec-sha') {
  try {
    requireArchitectureChoice(fakeStore(sha).store, 'FEAT-001', choice, ADR);
  } catch (error) {
    if (error instanceof SchemaValidationError) return error.errors[0];
  }
  throw new Error('expected proposal error');
}

afterEach(() => vi.restoreAllMocks());

describe('SA-158 architecture alternative', () => {
  it('opens a human decision carrying the proposed ADR and blocks design until answered', async () => {
    const { store, decisions } = fakeStore();
    const error = proposalError();
    expect(error.startsWith(ARCHITECTURE_PROPOSAL_ERROR)).toBe(true);
    await openArchitectureAlternative(store, 'FEAT-001', error);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].blocks).toEqual(['FEAT-001-DESIGN']);
    expect(decisions[0].context).toContain('Propuesto; decisión humana pendiente');
    expect(decisions[0].options.map((option) => option.id)).toEqual(['alternative', 'hexagonal']);
    expect(() => requireArchitectureDecision(store, 'FEAT-001')).toThrow(/decisión humana/);
  });

  it('publishes the accepted ADR only after the human chooses the alternative', async () => {
    const { store, decisions } = fakeStore();
    await openArchitectureAlternative(store, 'FEAT-001', proposalError());
    Object.assign(decisions[0], {
      status: 'answered',
      answer: 'alternative',
      answeredBy: 'operator',
      answeredAt: '2026-11-13T00:00:00Z',
    });
    expect(() => requireArchitectureDecision(store, 'FEAT-001')).not.toThrow();
    const adr = requireArchitectureChoice(store, 'FEAT-001', choice, ADR);
    expect(adr).toContain('Aceptado por el humano');
    expect(adr).toContain('Monolito en capas');
  });

  it('keeps the human answer when the architect rewords or reorders the same proposal', async () => {
    const { store, decisions } = fakeStore();
    await openArchitectureAlternative(store, 'FEAT-001', proposalError());
    Object.assign(decisions[0], {
      status: 'answered',
      answer: 'alternative',
      answeredBy: 'operator',
      answeredAt: '2026-11-13T00:00:00Z',
    });
    expect(architectureAnswer(store, 'FEAT-001')).toContain('Monolito en capas');
    const reworded = {
      alternatives: [...choice.alternatives].reverse(),
      rationale: 'Otra redacción',
      name: choice.name,
      kind: choice.kind,
    };
    expect(requireArchitectureChoice(store, 'FEAT-001', reworded, ADR)).toContain('Aceptado');
  });

  it('sends the architect back to hexagonal when the human keeps the template', async () => {
    const { store, decisions } = fakeStore();
    await openArchitectureAlternative(store, 'FEAT-001', proposalError());
    Object.assign(decisions[0], {
      status: 'answered',
      answer: 'hexagonal',
      answeredBy: 'operator',
      answeredAt: '2026-11-13T00:00:00Z',
    });
    expect(() => requireArchitectureChoice(store, 'FEAT-001', choice, ADR)).toThrow(
      SchemaValidationError,
    );
  });

  it('rejects proposals bound to stale requirements', async () => {
    const { store } = fakeStore('new-sha');
    await expect(
      openArchitectureAlternative(store, 'FEAT-001', proposalError('old-sha')),
    ).rejects.toThrow(/requirements changed/);
  });

  it('only the human may answer an architecture decision', async () => {
    const { store, decisions } = fakeStore();
    await openArchitectureAlternative(store, 'FEAT-001', proposalError());
    vi.spyOn(ingress, 'featureIngressActor').mockReturnValue('agent');
    expect(() => assertArchitectureAnswer(store, decisions[0].id)).toThrow(/humano/);
    vi.spyOn(ingress, 'featureIngressActor').mockReturnValue('human');
    expect(() => assertArchitectureAnswer(store, decisions[0].id)).not.toThrow();
  });
});
