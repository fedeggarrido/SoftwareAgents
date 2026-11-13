import type { SourceItem } from './research.js';

/** Claims use the Researcher source IDs and verbatim quote format. */
export interface StackClaim {
  text: string;
  sources: string[];
  quotes: { sourceId: string; text: string }[];
}

export interface StackAlternative {
  id: string;
  name: string;
  stack: Record<StackComponent, StackClaim>;
  comparison: Record<StackCriterion, StackClaim>;
  hexagonal: StackClaim;
}

export type StackComponent = 'language' | 'framework' | 'data' | 'hosting' | 'testing' | 'ci';
export type StackCriterion = 'fit' | 'maturity' | 'cost' | 'learningCurve' | 'risks' | 'ecosystem';

export interface StackProposal {
  alternatives: StackAlternative[];
  recommendation: string;
  why: StackClaim;
  losses: { alternative: string; detail: StackClaim }[];
}

/** Runtime-owned binding, persisted atomically with the Human Decision. */
export interface ProjectStackDecision {
  feature: string;
  specSha: string;
  adrPath: string;
  proposal: StackProposal;
  bibliography: SourceItem[];
}
