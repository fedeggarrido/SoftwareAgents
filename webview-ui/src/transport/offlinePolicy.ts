import type { ClientMessage } from '../../../core/src/messages.js';

/**
 * What happens to a message while the office is offline:
 * - `read`: queued; asking again later changes nothing.
 * - `save`: only the latest of its type is kept and saved on reconnection.
 * - `action`: dropped with a notice; replaying it later could apply a stale intention.
 * - `live`: like an action, but its caller also handles the refusal.
 */
type OfflineHandling = 'read' | 'save' | 'action' | 'live';

/** Exhaustive on purpose: a new message must choose what happens to it offline. */
const OFFLINE_HANDLING: Record<ClientMessage['type'], OfflineHandling> = {
  webviewReady: 'read',
  requestAuditLog: 'read',
  requestDiagnostics: 'read',
  requestExecutorState: 'read',
  requestFeaturePlan: 'read',
  requestFeatures: 'read',
  requestGithubHosting: 'read',
  requestIdeas: 'read',
  requestNewProject: 'read',
  requestProjectSummary: 'read',
  requestTaskDetail: 'read',
  browseProjectDirectories: 'read',
  validateNewProject: 'read',
  saveAgentSeats: 'save',
  saveAreaMappings: 'save',
  saveLayout: 'save',
  setAlwaysShowLabels: 'save',
  setGhostHeadlessAgents: 'save',
  setHooksInfoShown: 'save',
  setLastSeenVersion: 'save',
  setShowAreas: 'save',
  setSoundEnabled: 'save',
  addExternalAssetDirectory: 'action',
  approveFeaturePlan: 'action',
  closeAgent: 'action',
  companyAutopilot: 'action',
  companyDecision: 'action',
  confirmGithubHosting: 'action',
  createNewProject: 'action',
  exportLayout: 'action',
  extractIdeaDocument: 'action',
  focusAgent: 'action',
  hooksConsentResponse: 'action',
  importLayout: 'action',
  launchAgent: 'action',
  openSessionsFolder: 'action',
  removeExternalAssetDirectory: 'action',
  setHooksEnabled: 'action',
  setWatchAllSessions: 'action',
  prepareProject: 'live',
  rotateOfficeToken: 'live',
  setExecutorEnabled: 'live',
  setExecutorLevels: 'live',
  submitIdea: 'live',
  submitTaskChange: 'live',
};

export function offlineHandling(type: ClientMessage['type']): OfflineHandling {
  return OFFLINE_HANDLING[type];
}
