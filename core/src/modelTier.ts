/** Model identifiers belong exclusively to Operator config. */
export type ModelTier = 'economy' | 'standard' | 'deep';
export type WorkType =
  'summary' | 'classification' | 'docs' | 'implementation' | 'review' | 'qa' | 'architecture';
export type WorkSize = 'S' | 'M' | 'L';
export interface TierRule {
  capabilityWeights: Record<string, number>;
  workTypeWeights: Record<WorkType, number>;
  sizeWeights: Record<WorkSize, number>;
  thresholds: Record<ModelTier, number>;
}
export interface TierCandidate {
  executor: 'claude' | 'codex';
  model: string;
  effort?: string;
}
export interface ModelTierPolicy {
  maxTier: ModelTier;
  tiers: Partial<Record<ModelTier, { candidates: TierCandidate[]; fallbackTo?: ModelTier }>>;
  /** Overrides the repository's rule, without granting execution authority. */
  rule?: TierRule;
}
