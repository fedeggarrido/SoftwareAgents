/** Bounded excerpts only; never store complete works. */
export const RESEARCH_EXCERPT_CHARS = 4000;
export const RESEARCH_QUOTE_CHARS = 300;
export const RESEARCH_HTTP_BYTES = 1048576;
export const RESEARCH_HTTP_MS = 10000;
export type SourceKind = 'video' | 'thread' | 'book' | 'article' | 'paper' | 'podcast' | 'web';
export type ResearchTopic = 'alternatives' | 'technologies' | 'risks' | 'practices';
export interface SourceItem {
  /** Optional for legacy persisted reports; runtime normalizes it at ingress. */
  provenance?: 'untrusted-external';
  id: string;
  adapter: string;
  url?: string;
  citation?: string;
  title: string;
  author?: string;
  channel?: string;
  publishedAt?: string;
  retrievedAt: string;
  kind: SourceKind;
  excerpt: string;
  signals?: { votes?: number; views?: number; citations?: number; authorReputation?: number };
  language: string;
  contentHash: string;
}
export interface ResearchReport {
  summary: string;
  findings: {
    claim: string;
    topic?: ResearchTopic;
    type: 'fact' | 'opinion' | 'anecdote';
    confidence: 'high' | 'medium' | 'low';
    reason: string;
    sources: string[];
    quotes?: { sourceId: string; text: string }[];
  }[];
  contradictions: { claim: string; sources: string[] }[];
  gaps: string[];
  discardedSources: { id: string; reason: string }[];
  bibliography: SourceItem[];
}
export interface ResearchOperatorConfig {
  maxSources?: number;
  maxTokens?: number;
  maxSeconds?: number;
  maxCostUsd?: number;
  modes?: Partial<Record<ResearchMode, ResearchModeLimits>>;
  /** Operator-contracted JSON provider: GET ?q=... returns { urls: string[] }. */
  search?: { endpoint: string; apiKey?: string };
  reddit?: { clientId: string; clientSecret: string; userAgent: string };
}

export type ResearchMode = 'quick' | 'deep';
export interface ResearchModeLimits {
  maxSources?: number;
  maxTokens?: number;
  maxSeconds?: number;
  maxCostUsd?: number;
}
