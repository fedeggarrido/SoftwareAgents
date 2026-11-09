/**
 * AUTO-GENERATED FROM core/asyncapi.yaml. DO NOT EDIT MANUALLY.
 *
 * Run `npm run asyncapi:generate` to regenerate.
 *
 * Source of truth: the yaml at core/asyncapi.yaml.
 * Editors and clients in any language can consume the spec directly.
 */

export type ServerMessage =
  | OfficeTokenRotationFailed
  | OfficeAccess
  | FeaturePlanSnapshot
  | FeatureApprovalResult
  | IdeasSnapshot
  | SubmitIdeaResult
  | PrepareProjectResult
  | FeaturesSnapshot
  | AuditLogSnapshot
  | ProviderCapabilities
  | AgentCreated
  | AgentClosed
  | AgentSelected
  | ExistingAgents
  | AgentStatus
  | AgentToolStart
  | AgentToolDone
  | AgentToolsClear
  | AgentToolPermission
  | AgentToolPermissionClear
  | SubagentToolStart
  | SubagentToolDone
  | SubagentClear
  | SubagentToolPermission
  | AgentTeamInfo
  | AgentContextUsage
  | LayoutLoaded
  | FurnitureAssetsLoaded
  | CharacterSpritesLoaded
  | PetSpritesLoaded
  | FloorTilesLoaded
  | WallTilesLoaded
  | CarpetTilesLoaded
  | SettingsLoaded
  | HooksStatus
  | HooksConsentRequest
  | ExternalAssetDirectoriesUpdated
  | AreaMappingsLoaded
  | WorkspaceFolders
  | BoardState
  | AgentRole
  | AgentProviderLabel
  | CompanyNotice
  | ExecutorState
  | ExecutorToggleResult
  | WorkSnapshot
  | DomainEventMessage
  | AgentDiagnostics;

export type ClientMessage =
  | RequestFeaturePlan
  | ApproveFeaturePlan
  | RequestIdeas
  | SubmitIdea
  | PrepareProject
  | RequestFeatures
  | RequestAuditLog
  | WebviewReady
  | LaunchAgent
  | FocusAgent
  | CloseAgent
  | SaveAgentSeats
  | SaveLayout
  | SetSoundEnabled
  | SetLastSeenVersion
  | SetAlwaysShowLabels
  | SetGhostHeadlessAgents
  | SetHooksEnabled
  | HooksConsentResponse
  | SetHooksInfoShown
  | RotateOfficeToken
  | SetWatchAllSessions
  | ExportLayout
  | ImportLayout
  | OpenSessionsFolder
  | AddExternalAssetDirectory
  | RemoveExternalAssetDirectory
  | SaveAreaMappings
  | SetShowAreas
  | RequestDiagnostics
  | CompanyAutopilot
  | CompanyDecision
  | SetExecutorEnabled
  | SetExecutorLevels
  | RequestExecutorState;

export interface OfficeTokenRotationFailed {
  type: 'officeTokenRotationFailed';
}

export interface OfficeAccess {
  type: 'officeAccess';
  privileged: boolean;
  persistent?: boolean;
  reason: OfficeAccessReason | null;
}

export type OfficeAccessReason = 'token_required' | 'managed_process';

export interface FeaturePlanSnapshot {
  type: 'featurePlanSnapshot';
  projectId: string;
  requestId: string;
  key: string;
  canApprove: boolean;
  approvalBlock: FeaturePlanApprovalBlock | null;
  errorCode: FeaturePlanError | null;
  plan: FeaturePlan | null;
}

export type FeaturePlanApprovalBlock =
  'read_only' | 'managed_process' | 'unsupported_adapter' | 'stale_revision' | 'unavailable';

export type FeaturePlanError =
  | 'denied'
  | 'unsupported_adapter'
  | 'invalid_request'
  | 'unknown_project'
  | 'unavailable'
  | 'stale_revision'
  | 'approval_blocked'
  | 'managed_process';

export interface FeaturePlan {
  key: string;
  title: string;
  revision: string;
  specSha: string;
  specApproved: boolean;
  approved: boolean;
  approvalState: FeaturePlanApprovalState;
  summary: FeaturePlanSummary;
  sections: FeaturePlanSection[];
}

export type FeaturePlanApprovalState =
  'pending' | 'approved' | 'changed' | 'unbound' | 'finished' | 'merged';

export interface FeaturePlanSummary {
  goal: string;
  userValue: string;
  outOfScope: string[];
  risks: string[];
  acceptance: string[];
  tasks: FeaturePlanTask[];
}

export interface FeaturePlanTask {
  key: string;
  title: string;
  size: FeaturePlanTaskSize;
  dependencies: string[];
}

export type FeaturePlanTaskSize = 'S' | 'M' | 'L';

export interface FeaturePlanSection {
  id: FeaturePlanSectionId;
  title: string;
  content: string | null;
  items: string[];
}

export type FeaturePlanSectionId =
  'requirements' | 'architecture' | 'tasks' | 'tests' | 'ci' | 'security' | 'documentation';

export interface FeatureApprovalResult {
  type: 'featureApprovalResult';
  projectId: string;
  requestId: string;
  key: string;
  revision: string;
  status: FeatureApprovalStatus;
  errorCode: FeaturePlanError | null;
}

export type FeatureApprovalStatus = 'approved' | 'rejected';

export interface IdeasSnapshot {
  type: 'ideasSnapshot';
  requestId: string;
  projectId: string | null;
  canSubmit: boolean;
  preparation?: ProjectPreparation;
  preparationError?: ProjectPreparationError;
  errorCode: IdeaErrorCode | null;
  ideas: IdeaSummary[];
}

export interface ProjectPreparation {
  id: string;
  name: string;
  defaultBranch: string;
  remote: string;
  configPath: string;
  brainPath: string;
}

export type ProjectPreparationError =
  | 'denied'
  | 'unsupported_adapter'
  | 'invalid_request'
  | 'not_git'
  | 'already_exists'
  | 'unsafe_storage'
  | 'unsafe_remote'
  | 'operator_conflict'
  | 'unavailable'
  | 'audit_failed';

export type IdeaErrorCode =
  | 'denied'
  | 'unsupported_adapter'
  | 'no_project'
  | 'missing_manifest'
  | 'invalid_manifest'
  | 'unknown_project'
  | 'invalid_request'
  | 'empty_text'
  | 'too_large'
  | 'unsafe_storage'
  | 'unavailable'
  | 'ids_exhausted'
  | 'audit_failed';

export interface IdeaSummary {
  key: string;
  command: string;
}

export interface SubmitIdeaResult {
  type: 'submitIdeaResult';
  requestId: string;
  projectId: string;
  status: IdeaSubmitStatus;
  errorCode: IdeaErrorCode | null;
  idea: IdeaSummary | null;
}

export type IdeaSubmitStatus = 'saved' | 'rejected' | 'failed';

export interface PrepareProjectResult {
  type: 'prepareProjectResult';
  requestId: string;
  projectId: string | null;
  status: ProjectPreparationStatus;
  errorCode: ProjectPreparationError | null;
}

export type ProjectPreparationStatus = 'created' | 'rejected';

export interface FeaturesSnapshot {
  type: 'featuresSnapshot';
  projectId: string;
  requestId: string;
  status: FeaturesStatus;
  reason: FeaturesReadError | null;
  features: FeatureRow[];
}

export type FeaturesStatus = 'ok' | 'empty' | 'denied' | 'unknown_project' | 'read_error';

export type FeaturesReadError =
  'unavailable' | 'schema_incompatible' | 'query_failed' | 'invalid_data';

export interface FeatureRow {
  key: string;
  title: string | null;
  state: FeatureState;
  rawStatus: string | null;
  progress: FeatureProgress | null;
  currentTask: FeatureCurrentTask | null;
  gates: FeatureGate[];
  integration: FeatureIntegration | null;
  lastActivityAt: string | null;
  cost: FeatureCost;
  flow?: string;
}

export type FeatureState =
  'merged' | 'ready_to_merge' | 'in_review' | 'in_design' | 'in_development' | 'unknown';

export interface FeatureProgress {
  done: number;
  total: number;
}

export interface FeatureCurrentTask {
  key: string;
  step: FeatureTaskStep | null;
  others: number;
}

export type FeatureTaskStep = 'develop' | 'review' | 'qa';

export interface FeatureGate {
  kind: FeatureGateKind;
  task: string | null;
  expired: boolean;
  command: string;
  reason?: string;
}

export type FeatureGateKind =
  | 'spec_approval'
  | 'requirements_questions'
  | 'design_questions'
  | 'human_decision'
  | 'waiting_human'
  | 'quota'
  | 'qa_not_tested'
  | 'zone_overlap';

export interface FeatureIntegration {
  branch: string;
  sha: string | null;
}

export interface FeatureCost {
  executions: number;
  costKnown: number;
  costUsd: number | null;
  costPerDoneTaskUsd: number | null;
  cacheHitRate: number | null;
}

export interface AuditLogSnapshot {
  type: 'auditLog';
  projectId: string;
  requestId: string;
  status: AuditLogStatus;
  entries: AuditViewEntry[];
  totalValid: number;
  truncated: boolean;
  corruptLines: number[];
  excludedCount: number;
}

export type AuditLogStatus = 'ok' | 'empty' | 'read_error' | 'denied' | 'unknown_project';

export interface AuditViewEntry {
  line: number;
  occurredAt: string;
  actorType: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  policyDecision: AuditViewPolicyDecision | null;
  riskLevel: string;
  outcome: AuditViewOutcome;
  taskKey: string | null;
  executionId: string | null;
}

export interface AuditViewPolicyDecision {
  outcome: string;
  reason: string;
}

export interface AuditViewOutcome {
  status: string;
  reason: string | null;
  detail: string | null;
  tier: string | null;
  executor: string | null;
  model: string | null;
  code: string | null;
}

export interface ProviderCapabilities {
  type: 'providerCapabilities';
  readingTools: string[];
  subagentToolNames: string[];
}

export interface AgentCreated {
  type: 'agentCreated';
  projectId?: string;
  id: number;
  folderName?: string;
  isExternal?: boolean;
  palette?: number;
  hueShift?: number;
}

export interface AgentClosed {
  type: 'agentClosed';
  id: number;
}

export interface AgentSelected {
  type: 'agentSelected';
  id: number;
}

export interface ExistingAgents {
  type: 'existingAgents';
  agents: number[];
  agentMeta: Record<string, AgentSeatMeta>;
  folderNames: Record<string, string>;
  externalAgents: Record<string, boolean>;
}

export interface AgentSeatMeta {
  projectId?: string;
  palette?: number;
  hueShift?: number;
  seatId?: string;
}

export interface AgentStatus {
  type: 'agentStatus';
  id: number;
  status: AgentActivityStatus;
  awaitingInput?: boolean;
}

export type AgentActivityStatus = 'active' | 'waiting';

export interface AgentToolStart {
  type: 'agentToolStart';
  id: number;
  toolId: string;
  status: string;
  toolName?: string;
  permissionActive?: boolean;
  runInBackground?: boolean;
  isTeammateSpawn?: boolean;
}

export interface AgentToolDone {
  type: 'agentToolDone';
  id: number;
  toolId: string;
}

export interface AgentToolsClear {
  type: 'agentToolsClear';
  id: number;
}

export interface AgentToolPermission {
  type: 'agentToolPermission';
  id: number;
}

export interface AgentToolPermissionClear {
  type: 'agentToolPermissionClear';
  id: number;
}

export interface SubagentToolStart {
  type: 'subagentToolStart';
  id: number;
  parentToolId: string;
  toolId: string;
  status: string;
}

export interface SubagentToolDone {
  type: 'subagentToolDone';
  id: number;
  parentToolId: string;
  toolId: string;
}

export interface SubagentClear {
  type: 'subagentClear';
  id: number;
  parentToolId: string;
}

export interface SubagentToolPermission {
  type: 'subagentToolPermission';
  id: number;
  parentToolId: string;
}

export interface AgentTeamInfo {
  type: 'agentTeamInfo';
  id: number;
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  teamUsesTmux?: boolean;
}

export interface AgentContextUsage {
  type: 'agentContextUsage';
  id: number;
  contextTokens: number;
  maxContextTokens: number;
}

export interface LayoutLoaded {
  type: 'layoutLoaded';
  layout: Record<string, any> | null;
  wasReset?: boolean;
}

export interface FurnitureAssetsLoaded {
  type: 'furnitureAssetsLoaded';
  catalog: FurnitureAssetMessage[];
  sprites: Record<string, string[][]>;
}

export interface FurnitureAssetMessage {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  groupId?: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  state?: string;
  mirrorSide?: boolean;
  rotationScheme?: string;
  animationGroup?: string;
  frame?: number;
}

export interface CharacterSpritesLoaded {
  type: 'characterSpritesLoaded';
  characters: CharacterSpriteSet[];
}

export interface CharacterSpriteSet {
  down: string[][][];
  up: string[][][];
  right: string[][][];
}

export interface PetSpritesLoaded {
  type: 'petSpritesLoaded';
  pets: PetSpriteFrameSet[];
  petNames: string[];
}

export interface PetSpriteFrameSet {
  walkDown: string[][][];
  idleDown: string[][][];
  walkUp: string[][][];
  idleUp: string[][][];
  walkRight: string[][][];
}

export interface FloorTilesLoaded {
  type: 'floorTilesLoaded';
  sprites: string[][][];
}

export interface WallTilesLoaded {
  type: 'wallTilesLoaded';
  sets: string[][][][];
}

export interface CarpetTilesLoaded {
  type: 'carpetTilesLoaded';
  sets: string[][][][];
}

export interface SettingsLoaded {
  type: 'settingsLoaded';
  soundEnabled: boolean;
  lastSeenVersion: string;
  extensionVersion: string;
  watchAllSessions: boolean;
  alwaysShowLabels: boolean;
  ghostHeadlessAgents: boolean;
  hooksEnabled: boolean;
  hooksInfoShown: boolean;
  externalAssetDirectories: string[];
  showAreas: boolean;
}

export interface HooksStatus {
  type: 'hooksStatus';
  providerId: string;
  installed: boolean;
}

export interface HooksConsentRequest {
  type: 'hooksConsentRequest';
  providerId: string;
  headline: string;
  disclosure: string;
}

export interface ExternalAssetDirectoriesUpdated {
  type: 'externalAssetDirectoriesUpdated';
  dirs: string[];
}

export interface AreaMappingsLoaded {
  type: 'areaMappingsLoaded';
  mappings: Record<string, string[]>;
}

export interface WorkspaceFolders {
  type: 'workspaceFolders';
  folders: WorkspaceFolder[];
}

export interface WorkspaceFolder {
  name: string;
  path: string;
}

export interface BoardState {
  type: 'boardState';
  project: string;
  mode?: BoardMode;
  projectId?: string;
  clickupFolderUrl?: string;
  items: BoardItem[];
  manager?: BoardOwner;
  recent: BoardEvent[];
  sources: BoardSources;
  quota: BoardQuota;
  gate: BoardEvent[];
  summary: BoardSummary;
  waiting: BoardEvent[];
  decisions: BoardDecision[];
  meeting?: MeetingState;
  autopilot?: AutopilotState;
  generatedAt: number;
}

export type BoardMode = 'legacy' | 'project' | 'invalid';

export interface BoardItem {
  prRef?: string;
  prStatus?: PullRequestStatus;
  prObservation?: PullRequestObservation;
  id: string;
  clickupId?: string;
  title: string;
  epic?: string;
  priority?: string;
  size?: string;
  dependsOn?: string[];
  implementer?: string;
  phase: string;
  note?: string;
  owner?: BoardOwner;
  lastEvent?: BoardEvent;
  agentIds: number[];
}

export interface PullRequestStatus {
  ref: string;
  state: PullRequestState;
  isDraft: boolean;
  reviewDecision: PullRequestReviewDecision;
  ci: PullRequestCiState;
  failedChecks: string[];
  mergedAt: string | null;
  url: string;
  headRefName: string;
  observedAt: number;
}

export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED';

export type PullRequestReviewDecision = '' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';

export type PullRequestCiState = 'unknown' | 'pending' | 'success' | 'failure';

export interface PullRequestObservation {
  lastSuccessAt: number | null;
  attemptedAt: number;
  error: PullRequestObservationError | null;
}

export type PullRequestObservationError = 'unavailable' | 'binding_required';

export interface BoardOwner {
  worker: string;
  session: string;
  state: string;
  stale: boolean;
  heartbeatAt: number;
  worktree?: string;
}

export interface BoardEvent {
  at: number;
  session: string;
  phase: string;
  state: string;
  detail: string;
  task: string;
  provider?: string;
}

export interface BoardSources {
  workStore?: boolean;
  board: boolean;
  claims: boolean;
  progress: boolean;
}

export interface BoardQuota {
  claude: ProviderQuota;
  codex: ProviderQuota;
}

export interface ProviderQuota {
  provider: QuotaProvider;
  status: QuotaStatus;
  usedPercent: number | null;
  resetsAt: number | null;
  observedAt: number | null;
  capacity?: CapacitySnapshot;
  weekly?: QuotaWindow;
}

export type QuotaProvider = 'claude' | 'codex';

export type QuotaStatus = 'allowed' | 'warning' | 'rejected' | 'reset' | 'unknown';

export interface CapacitySnapshot {
  provider: QuotaProvider;
  status: QuotaStatus;
  windows: CapacityWindow[];
  source: CapacitySource;
  confidence: CapacityConfidence;
  observedAt: number | null;
}

export interface CapacityWindow {
  kind: CapacityWindowKind;
  limitId?: string;
  usedRatio: number | null;
  resetsAt: number | null;
}

export type CapacityWindowKind = 'five_hour' | 'weekly' | 'other';

export type CapacitySource = 'claude_stream_json' | 'codex_session_log' | 'estimated';

export type CapacityConfidence = 'exact' | 'high' | 'low' | 'unknown';

export interface QuotaWindow {
  usedPercent: number | null;
  resetsAt: number | null;
  windowMinutes?: number;
}

export interface BoardSummary {
  total: number;
  byPhase: Record<string, number>;
  byEpic: Record<string, EpicSummary>;
}

export interface EpicSummary {
  done: number;
  total: number;
}

export interface BoardDecision {
  id: string;
  structuredOptions?: HumanDecisionOption[];
  impact?: string;
  urgency?: DecisionUrgency;
  requestedBy?: string;
  answeredBy?: string | null;
  answeredAt?: string | null;
  disagreement?: DecisionDisagreement[];
  question: string;
  context?: string;
  options: string[];
  recommendation?: string;
  blocks?: string[];
  status: string;
  answer?: string | null;
  additionalProperties?: Record<string, any>;
}

export interface HumanDecisionOption {
  id: string;
  label: string;
  benefit: string;
  cost: string;
  risk: string;
}

export type DecisionUrgency = 'low' | 'medium' | 'high' | 'critical';

export interface DecisionDisagreement {
  role: string;
  position: string;
}

export interface MeetingState {
  id: string;
  format: string;
  topic: string;
  question: string;
  participants: string[];
  status: string;
  round: string;
  decision?: string | null;
  waitReason?: string;
  task?: string;
  lines: MeetingLine[];
  additionalProperties?: Record<string, any>;
}

export interface MeetingLine {
  at: number;
  round: string;
  role: string;
  stance: string;
  additionalProperties?: Record<string, any>;
}

export interface AutopilotState {
  enabled: boolean;
  running: boolean;
  status?: string;
  waitReason?: string;
  nextRound?: number | null;
  lastRound?: number;
  intervalMinutes?: number;
  additionalProperties?: Record<string, any>;
}

export interface AgentRole {
  type: 'agentRole';
  id: number;
  label: string;
  department: string;
  detail?: string;
  tier?: ModelTier;
  model?: string;
  effort?: string;
  selectionReason?: string;
  characterDetail?: CharacterDetail;
}

export type ModelTier = 'economy' | 'standard' | 'deep';

export interface CharacterDetail {
  prStatus?: PullRequestStatus;
  prObservation?: PullRequestObservation;
  prState?: string;
  ciState?: string;
  projectId: string;
  spec: string;
  role: string;
  taskKey: string;
  taskTitle: string;
  taskStatus: string;
  executor: string;
  model: string;
  tier: string;
  effort: string;
  elapsed: string;
  worktree: string;
  branch: string;
  pr: string;
  selectionReason: string;
  permissions: string;
  log: string;
}

export interface AgentProviderLabel {
  type: 'agentProviderLabel';
  id: number;
  label: string;
}

export interface CompanyNotice {
  type: 'companyNotice';
  text: string;
}

export interface ExecutorState {
  type: 'executorState';
  projectId: string;
  revision: string;
  sequence: number;
  observedAt: number;
  canManage: boolean;
  configurationStatus: ExecutorConfigurationStatus;
  executors: ExecutorAvailability[];
}

export type ExecutorConfigurationStatus = 'ready' | 'pending' | 'recovery_required' | 'invalid';

export interface ExecutorAvailability {
  executorId: ExecutorId;
  enabled: boolean;
  eligible: boolean;
  reasonCodes: ExecutorReasonCode[];
  installation: ExecutorInstallation;
  version: string | null;
  authentication: ExecutorAuthentication;
  levels: ModelTier[];
  catalogLevels?: ModelTier[];
  quotaGate: ExecutorQuotaGate;
  activeExecutions: number | null;
  concurrencyLimit: number | null;
  checkedAt: number | null;
  staleAfter: number | null;
}

export type ExecutorId = 'claude' | 'codex';

export type ExecutorReasonCode =
  | 'operator_disabled'
  | 'not_installed'
  | 'unsupported_version'
  | 'auth_required'
  | 'probe_unknown'
  | 'probe_stale'
  | 'quota_blocked'
  | 'quota_unknown'
  | 'concurrency_full'
  | 'no_allowed_level'
  | 'configuration_unavailable';

export type ExecutorInstallation = 'ready' | 'missing' | 'unsupported' | 'unknown';

export type ExecutorAuthentication = 'ready' | 'required' | 'unknown';

export type ExecutorQuotaGate = 'allow' | 'block' | 'unknown';

export interface ExecutorToggleResult {
  type: 'executorToggleResult';
  projectId: string;
  executorId: string;
  requestId: string;
  status: ExecutorToggleStatus;
  errorCode?: ExecutorToggleErrorCode;
  revision?: string;
}

export type ExecutorToggleStatus = 'applied' | 'unchanged' | 'rejected' | 'failed';

export type ExecutorToggleErrorCode =
  | 'unauthorized'
  | 'invalid_request'
  | 'unknown_project'
  | 'unknown_executor'
  | 'policy_denied'
  | 'revision_conflict'
  | 'apply_failed'
  | 'persist_failed'
  | 'audit_failed'
  | 'recovery_required'
  | 'not_supported';

export interface WorkSnapshot {
  type: 'workSnapshot';
  projectId: string;
  source: WorkSnapshotSource;
  lastEventId: number | null;
  tasks: WorkTask[];
  decisions: WorkDecision[];
  generatedAt: number;
}

export type WorkSnapshotSource = 'ok' | 'missing' | 'unreadable';

export interface WorkTask {
  prRef?: string;
  prStatus?: PullRequestStatus;
  prObservation?: PullRequestObservation;
  key: string;
  type: string;
  status: WorkTaskStatus;
  priority: number;
  agentRole: string | null;
  featureKey: string | null;
  version: number;
  attempt: number;
  dependsOn: string[];
  updatedAt: number;
}

export type WorkTaskStatus =
  | 'DRAFT'
  | 'READY'
  | 'QUEUED'
  | 'LEASED'
  | 'RUNNING'
  | 'REVIEW'
  | 'QA'
  | 'DONE'
  | 'BLOCKED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FINAL'
  | 'WAITING_HUMAN'
  | 'WAITING_QUOTA'
  | 'CANCELLED';

export interface WorkDecision {
  id: string;
  status: WorkDecisionStatus;
  context: string;
  options: HumanDecisionOption[];
  recommendation: string;
  urgency: DecisionUrgency;
  impact: string;
  requestedBy: string;
  blocks: string[];
}

export type WorkDecisionStatus = 'open' | 'expired';

export interface DomainEventMessage {
  type: 'domainEvent';
  event: DomainEventPayload;
}

export interface DomainEventPayload {
  eventId: number;
  kind: DomainEventKind;
  projectId: string;
  taskKey: string;
  agentRole: string | null;
  executionId: string | null;
  at: number;
  fromStatus?: WorkTaskStatus;
  toStatus?: WorkTaskStatus;
  taskVersion?: number;
  attempt?: number;
  decisionId?: string | null;
}

export type DomainEventKind =
  | 'task.created'
  | 'task.state_changed'
  | 'task.leased'
  | 'execution.started'
  | 'execution.finished'
  | 'review.requested'
  | 'qa.requested'
  | 'quota.waiting'
  | 'quota.exhausted'
  | 'human.decision.required'
  | 'human.decision.answered'
  | 'pr.updated'
  | 'pr.merged';

export interface AgentDiagnostics {
  type: 'agentDiagnostics';
  agents: Record<string, any>[];
}

export interface RequestFeaturePlan {
  type: 'requestFeaturePlan';
  projectId: string;
  requestId: string;
  key: string;
}

export interface ApproveFeaturePlan {
  type: 'approveFeaturePlan';
  projectId: string;
  requestId: string;
  key: string;
  revision: string;
}

export interface RequestIdeas {
  type: 'requestIdeas';
  requestId: string;
}

export interface SubmitIdea {
  type: 'submitIdea';
  requestId: string;
  projectId: string;
  text: string;
  answers: IdeaAnswer[];
}

export interface IdeaAnswer {
  questionId: IdeaQuestionId;
  choice: IdeaAnswerChoice;
  text: string;
}

export type IdeaQuestionId =
  | 'objetivo'
  | 'usuarios'
  | 'alcance'
  | 'fuera_de_alcance'
  | 'criterio_de_exito'
  | 'restricciones'
  | 'riesgos';

export type IdeaAnswerChoice = 'answer' | 'decide';

export interface PrepareProject {
  type: 'prepareProject';
  requestId: string;
  name: string;
}

export interface RequestFeatures {
  type: 'requestFeatures';
  projectId: string;
  requestId: string;
}

export interface RequestAuditLog {
  type: 'requestAuditLog';
  projectId: string;
  requestId: string;
}

export interface WebviewReady {
  type: 'webviewReady';
  capabilities?: ClientCapability[];
}

export type ClientCapability = 'executorControls';

export interface LaunchAgent {
  type: 'launchAgent';
  folderPath?: string;
  bypassPermissions?: boolean;
}

export interface FocusAgent {
  type: 'focusAgent';
  id: number;
}

export interface CloseAgent {
  type: 'closeAgent';
  id: number;
}

export interface SaveAgentSeats {
  type: 'saveAgentSeats';
  seats: Record<string, SeatAssignment>;
}

export interface SeatAssignment {
  palette: number;
  hueShift: number;
  seatId: string | null;
}

export interface SaveLayout {
  type: 'saveLayout';
  layout: Record<string, any>;
}

export interface SetSoundEnabled {
  type: 'setSoundEnabled';
  enabled: boolean;
}

export interface SetLastSeenVersion {
  type: 'setLastSeenVersion';
  version: string;
}

export interface SetAlwaysShowLabels {
  type: 'setAlwaysShowLabels';
  enabled: boolean;
}

export interface SetGhostHeadlessAgents {
  type: 'setGhostHeadlessAgents';
  enabled: boolean;
}

export interface SetHooksEnabled {
  type: 'setHooksEnabled';
  providerId: string;
  enabled: boolean;
}

export interface HooksConsentResponse {
  type: 'hooksConsentResponse';
  providerId: string;
  choice: HooksConsentChoice;
}

export type HooksConsentChoice = 'install' | 'notNow' | 'never';

export interface SetHooksInfoShown {
  type: 'setHooksInfoShown';
}

export interface RotateOfficeToken {
  type: 'rotateOfficeToken';
}

export interface SetWatchAllSessions {
  type: 'setWatchAllSessions';
  enabled: boolean;
}

export interface ExportLayout {
  type: 'exportLayout';
}

export interface ImportLayout {
  type: 'importLayout';
}

export interface OpenSessionsFolder {
  type: 'openSessionsFolder';
}

export interface AddExternalAssetDirectory {
  type: 'addExternalAssetDirectory';
  path?: string;
}

export interface RemoveExternalAssetDirectory {
  type: 'removeExternalAssetDirectory';
  path: string;
}

export interface SaveAreaMappings {
  type: 'saveAreaMappings';
  mappings: Record<string, string[]>;
}

export interface SetShowAreas {
  type: 'setShowAreas';
  enabled: boolean;
}

export interface RequestDiagnostics {
  type: 'requestDiagnostics';
}

export interface CompanyAutopilot {
  type: 'companyAutopilot';
  enabled: boolean;
}

export interface CompanyDecision {
  type: 'companyDecision';
  id: string;
  answer: string;
}

export interface SetExecutorEnabled {
  type: 'setExecutorEnabled';
  projectId: string;
  executorId: ExecutorId;
  enabled: boolean;
  requestId: string;
  expectedRevision: string;
}

export interface SetExecutorLevels {
  type: 'setExecutorLevels';
  projectId: string;
  executorId: ExecutorId;
  levels: ModelTier[];
  requestId: string;
  expectedRevision: string;
}

export interface RequestExecutorState {
  type: 'requestExecutorState';
  projectId: string;
}
