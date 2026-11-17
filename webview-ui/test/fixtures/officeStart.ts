import type { BoardState, FeaturesSnapshot } from '../../../core/src/messages.js';
import type { FeaturesStore } from '../../src/office/featuresStore.js';

export const emptyBoard = (overrides: Partial<BoardState> = {}): BoardState => ({
  type: 'boardState',
  project: 'Proyecto',
  mode: 'legacy',
  items: [],
  recent: [],
  sources: { board: false, claims: false, progress: false },
  quota: {
    claude: {
      provider: 'claude',
      status: 'unknown',
      usedPercent: null,
      resetsAt: null,
      observedAt: null,
    },
    codex: {
      provider: 'codex',
      status: 'unknown',
      usedPercent: null,
      resetsAt: null,
      observedAt: null,
    },
  },
  gate: [],
  summary: { total: 0, byPhase: {}, byEpic: {} },
  waiting: [],
  decisions: [],
  generatedAt: 0,
  ...overrides,
});

export const emptyFeatures = (overrides: Partial<FeaturesSnapshot> = {}): FeaturesStore => ({
  projectId: 'P',
  requestId: 'r1',
  loading: false,
  snapshot: {
    type: 'featuresSnapshot',
    projectId: 'P',
    requestId: 'r1',
    status: 'empty',
    reason: null,
    features: [],
    ...overrides,
  },
});
