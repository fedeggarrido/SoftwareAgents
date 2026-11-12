// ── JSONL File Watching ─────────────────────────────────────
export const JSONL_POLL_INTERVAL_MS = 1000;
/** Bounded inter-process audit lock contention, including Windows pending unlink. */
export const AUDIT_LOCK_TIMEOUT_MS = 5_000;
export const AUDIT_LOCK_POLL_MS = 10;
/** Bounded contention for the execution ledger; never steal another writer's lock. */
export const EXECUTION_REGISTRY_LOCK_TIMEOUT_MS = 1_000;
export const FILE_WATCHER_POLL_INTERVAL_MS = 500;
export const PROJECT_SCAN_INTERVAL_MS = 1000;

// ── Heuristic Agent Status Detection ────────────────────────
// These timers are the fallback when CLI hooks are not active
// (hookDelivered = false). When hooks are working, these are
// suppressed and the server receives instant events instead.
/** Delay before sending agentToolDone (prevents UI flicker on rapid tool transitions) */
export const TOOL_DONE_DELAY_MS = 300;
/** Heuristic: time after a non-exempt tool starts before showing permission bubble.
 *  Not used for teammates -- false positives on slow tools (WebFetch/WebSearch).
 *  Teammates rely on the lead's routed Notification(permission_prompt) hook. */
export const PERMISSION_TIMER_DELAY_MS = 7000;
/** Heuristic: silence duration before marking a text-only turn as complete */
export const TEXT_IDLE_DELAY_MS = 5000;
/** Heuristic: idle threshold for per-agent /clear detection (content check prevents stealing) */
export const CLEAR_IDLE_THRESHOLD_MS = 2000;

// ── External Session Detection ──────────────────────────────
export const EXTERNAL_SCAN_INTERVAL_MS = 3000;
/** Only adopt JSONL files modified within this window */
export const EXTERNAL_ACTIVE_THRESHOLD_MS = 120_000; // 2 minutes
/** Remove external agents after this much inactivity */
// export const EXTERNAL_STALE_TIMEOUT_MS = 300_000; // 5 minutes - deprecated
export const EXTERNAL_STALE_CHECK_INTERVAL_MS = 30_000;
/** Cooldown after user closes an agent via X. Must be > EXTERNAL_ACTIVE_THRESHOLD_MS
 *  so the file's mtime becomes stale before the dismissal expires. */
export const DISMISSED_COOLDOWN_MS = 180_000; // 3 minutes

// ── Context Window Usage ────────────────────────────────────
/** Window size assumed until a transcript proves otherwise. Transcripts never
 *  state the model's context limit, so this is the floor, not the truth. */
export const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
/** Known window sizes, ascending. The smallest tier that fits the largest
 *  context observed so far wins; beyond the last tier we round up to a whole
 *  multiple of it, so an unknown future window still reads under 100%. */
export const CONTEXT_WINDOW_TIERS = [200_000, 1_000_000] as const;
/** How much of a transcript's tail to read when seeding an agent's context on
 *  adoption or restore. Comfortably more than one turn's worth of records. */
export const CONTEXT_SEED_TAIL_BYTES = 256 * 1024;

// ── Global Session Scanning ─────────────────────────────────
/** Only adopt global JSONL files larger than this (filters out empty/init-only sessions) */
export const GLOBAL_SCAN_ACTIVE_MIN_SIZE = 3_072; // 3KB
/** Only adopt global JSONL files modified within this window */
export const GLOBAL_SCAN_ACTIVE_MAX_AGE_MS = 600_000; // 10 minutes

// ── Display Truncation + Pixel Agents Server paths ──────────
// Centralized in core/src/constants.ts; re-exported here for back-compat.
export {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  HOOK_API_PREFIX,
  HOOK_SCRIPTS_DIR,
  SERVER_JSON_DIR,
  SERVER_JSON_NAME,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from '../../core/src/constants.js';

// ── Multi-Server Discovery ──────────────────────────────────
/** Subdirectory (under SERVER_JSON_DIR) holding one registry entry per live
 *  server, so a hook event can fan out to every running instance instead of
 *  only the single legacy server.json pointer. See server/src/server.ts. */
export const SERVERS_DIR = 'servers';
/** Valid explicit TCP port range. Port 0 remains an internal-only signal for
 *  OS-assigned ephemeral binding and is never accepted from persisted records
 *  or the CLI's --port option. */
export const MIN_PORT = 1;
export const MAX_PORT = 65_535;
/** Format version stamped on every registry entry (both the per-server records
 *  and the legacy server.json). Bump on breaking field changes; additive
 *  fields (servesSpa, protocol itself) don't require a bump -- readers already
 *  tolerate unknown/missing fields (see ServerConfig.debugLog precedent). */
export const SERVER_REGISTRY_PROTOCOL_VERSION = 1;
export const TOKEN_ROTATE_REQUEST_TIMEOUT_MS = 10_000;
export const OFFICE_CREDENTIAL_FILE = 'office-access.json';
export const OFFICE_TOKEN_POLL_MS = 1000;
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_COMMAND_TIMEOUT_MS = 5000;
/** A live PID is not a live server (Windows recycles PIDs, SA-076): before reuse,
 *  /api/health must answer on the entry's port with the same PID. A refused
 *  connection arrives in milliseconds; past this deadline the server is busy,
 *  so it is neither reused nor pruned. */
export const SERVER_HEALTH_PROBE_TIMEOUT_MS = 1500;
/** Legacy hook validation stays cheap; registry fan-out does not add probes. */
export const HOOK_LEGACY_PROBE_TIMEOUT_MS = 300;
/** Publication/cleanup lock is never held over network work. */
export const SERVER_DISCOVERY_LOCK_TIMEOUT_MS = 300;
/** Critical sections last milliseconds; expiry also recovers recycled PIDs. */
export const SERVER_DISCOVERY_LOCK_LEASE_MS = 10_000;
export const SERVER_DISCOVERY_RETRY_MIN_MS = 100;
export const SERVER_DISCOVERY_RETRY_MAX_MS = 5000;
/** Short Windows rename retries; longer failures use publication backoff. */
export const SERVER_DISCOVERY_RENAME_TIMEOUT_MS = 100;
/** Our /api/health body is tiny; anything longer is not ours and is not buffered. */
export const SERVER_HEALTH_MAX_BODY_CHARS = 4096;

// ── WebSocket close codes (application range 4000-4999) ────
/** Embedded mode: Bearer token missing or wrong. */
export const WS_CLOSE_UNAUTHORIZED = 4001;
/** Standalone mode: the handshake's Origin is not this server's own origin.
 *  WebSocket connects bypass CORS, so this is the only thing standing between
 *  a drive-by web page and the privileged client-message channel. */
export const WS_CLOSE_FORBIDDEN_ORIGIN = 4003;

export const HOOK_EVENT_BUFFER_MS = 5_000;
/** Grace period after SessionEnd(reason=clear/resume) before triggering onSessionEnd.
 *  /clear and /resume fire SessionEnd then SessionStart within ms. This timeout is a
 *  safety net: if SessionStart never arrives (e.g. the CLI crashes mid-transition),
 *  the agent is cleaned up instead of staying as a zombie with pendingClear forever. */
export const SESSION_END_GRACE_MS = 2000;
export const MAX_HOOK_BODY_SIZE = 65_536; // 64KB
/** Per-string cap applied to tool_input only when a hook body would exceed MAX_HOOK_BODY_SIZE. */
export const HOOK_INPUT_STRING_MAX_CHARS = 2_000;

// ── Layout/Config Persistence ──────────────────────────────
export const LAYOUT_FILE_DIR = '.pixel-agents';
export const LAYOUT_FILE_NAME = 'layout.json';
export const LAYOUT_FILE_POLL_INTERVAL_MS = 2000;
export const LAYOUT_REVISION_KEY = 'layoutRevision';
export const CONFIG_FILE_NAME = 'config.json';
export const CONFIG_FILE_MODE = 0o600;
/** Whole-file config lock shared by every writer (SA-088). An availability change
 *  holds it across up to three audit appends (each may wait AUDIT_LOCK_TIMEOUT_MS),
 *  so the lease must exceed that; a dead owner is reclaimed at once by PID. */
export const CONFIG_LOCK_DIR = 'locks';
export const CONFIG_LOCK_NAME = 'config.lock';
export const CONFIG_LOCK_TIMEOUT_MS = 2000;
export const CONFIG_LOCK_LEASE_MS = 30_000;

// ── Executor availability probes (SA-089) ──────────────────
/** Per probe command; a hung CLI is killed and reads as unknown. */
export const EXECUTOR_PROBE_TIMEOUT_MS = 3000;
/** Probe stdout/stderr beyond this is discarded (never shown, only parsed). */
export const EXECUTOR_PROBE_MAX_OUTPUT = 128 * 1024;
/** Enabled Executors are re-probed this often while healthy. */
export const EXECUTOR_PROBE_REFRESH_MS = 60_000;
/** Failing probes back off exponentially up to this. */
export const EXECUTOR_PROBE_MAX_BACKOFF_MS = 300_000;
/** An observation older than this is reported probe_stale. */
export const EXECUTOR_PROBE_TTL_MS = 120_000;

// ── Avatar Customization ────────────────────────────────────
/** Number of pre-colored bundled character palettes (char_0.png–char_5.png).
 *  Mirrors `PALETTE_COUNT` in webview-ui/src/constants.ts; kept separate
 *  because the server has no DOM/sprite access and cannot import the webview
 *  constant. The two values must stay in sync. */
export const PALETTE_COUNT = 6;
/** Inclusive upper bound for a valid agent hue shift, in degrees. Used by
 *  clientMessageHandler to guard saveAgentSeats payloads from a remote or
 *  hand-edited source corrupting the stored values with out-of-range values. */
export const HUE_SHIFT_MAX_DEG = 360;

// Operational WorkStore defaults; transition policy lives in workstore/taskStateMachine.
export const WORKSTORE_BUSY_TIMEOUT_MS = 5000;
/** Machine-wide observation the quota gate reads (SA-036/SA-QA-3); it goes stale after 60 s. */
export const MACHINE_CAPACITY_FILE_NAME = 'machine-capacity.json';
export const MACHINE_CAPACITY_PUBLISH_MS = 15_000;
/** --ignore-user-config also drops the operator's Windows sandbox mode. Without the
 *  elevated sandbox, codex exec rejects every shell command (even reads) on Windows. */
export const CODEX_WINDOWS_SANDBOX = 'elevated';
/** Codex enables web search by default (0.160.0 says so in its own `[features].web_search`
 *  deprecation notice) and --ignore-user-config keeps that default, so agents turn it off
 *  explicitly. Modes accepted by 0.160.0: disabled, cached, indexed, live (SA-074). */
export const CODEX_WEB_SEARCH_MODE = 'disabled';
/** Account-level Codex features that add tools beyond the sandbox, disabled for every slice
 *  profile (SA-QA-4). `apps` injects the ChatGPT connectors as the `codex_apps` MCP server even
 *  under --ignore-user-config: measured on 0.160.0, 243 tools (Gmail send/delete, ClickUp writes,
 *  Sites deploys, phone calls, an internet tool) that `-c features.apps=false` removes. The rest
 *  add browser, plugin and plugin-install tools; 0.160.0 accepts every one of these keys. */
export const CODEX_DISABLED_FEATURES: readonly string[] = [
  'apps',
  'plugins',
  'remote_plugin',
  'tool_suggest',
  'skill_mcp_dependency_install',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'in_app_browser',
];
/** Codex injects the worktree's AGENTS.md as user-role instructions, outside the untrusted-data
 *  boundary; 0 bytes turns that off (measured on 0.160.0). Slice agents get context from the
 *  declared Brain paths instead. */
export const CODEX_PROJECT_DOC_MAX_BYTES = 0;
/** Codex 0.160.0 lets any run spawn sub-agents (spawn_agent/wait_agent...) and no flag stops it:
 *  `features.multi_agent=false` and `agents.max_depth=0` both still spawned (SA-QA-4). The Executor
 *  fails the run on a `collab_tool_call` item and on any rollout whose `parent_thread_id` is its
 *  thread, polled at this interval. */
export const CODEX_SUBAGENT_POLL_MS = 1000;
/** Allow concurrent rollout writers to finish their headers after the CLI closes. */
export const CODEX_SUBAGENT_FINAL_TIMEOUT_MS = 2500;
export const CODEX_SUBAGENT_FINAL_RETRY_MS = 100;
/** session_meta carries base instructions (~20 KB); the parent id sits before them. */
export const CODEX_SUBAGENT_HEADER_BYTES = 256 * 1024;
/** Repository-provided Codex configuration or skills: the Codex Executor refuses such a worktree. */
export const CODEX_REPO_CONFIG_DIRS: readonly string[] = ['.codex', '.agents'];
export const WORKSTORE_INITIAL_TASK_STATUS = 'DRAFT';
export const WORKSTORE_DEFAULT_MAX_ATTEMPTS = 3;
/** Async OS helper deadline, including native-helper compilation and descendant discovery. */
export const WORKSTORE_PROCESS_TIMEOUT_MS = 60_000;
export const WORKSTORE_PROCESS_WAIT_MS = 10_000;
/** Reason a reconciled (expired) Human Decision writes on each Task it releases. */
export const WORKSTORE_RECONCILE_REASON_PREFIX = 'Reconcile expired decision: ';
/** Domain-event relay (SA-029): how often the office polls domain_events, and rows per read. */
export const DOMAIN_EVENT_POLL_MS = 1000;
export const DOMAIN_EVENT_BATCH_LIMIT = 200;
/** Batches per poll before yielding; a backlog beyond this drains over the next polls. */
export const DOMAIN_EVENT_MAX_BATCHES_PER_POLL = 5;
/** Retry failed process-tree termination for this long; an unconfirmed close never finishes. */
export const EXECUTOR_TERMINATION_TIMEOUT_MS = 5_000;
export const EXECUTOR_TERMINATION_RETRY_MS = 250;
/** Every taskkill gets a full budget, even near the end of the retry window. */
export const EXECUTOR_TASKKILL_TIMEOUT_MS = 2000;

/** Dead office publications are retained for quota diagnostics for one day. */
export const MACHINE_CAPACITY_RETENTION_S = 24 * 60 * 60;
// SA-095: bounded, content-free Execution telemetry (local + optional OTLP).
export const TELEMETRY_FILE_BYTES = 8 * 1024 * 1024;
export const TELEMETRY_SPAN_BYTES = 16 * 1024;
export const TELEMETRY_TOOL_LIMIT = 2048;
export const TELEMETRY_MESSAGE_LIMIT = 2048;
export const TELEMETRY_IDENTIFIER_LENGTH = 100;
export const TELEMETRY_ROLLOUT_BYTES = 8 * 1024 * 1024;
export const TELEMETRY_EXPORT_CONCURRENCY = 4;
export const TELEMETRY_EXPORT_TIMEOUT_MS = 1000;
export const TELEMETRY_LOCK_TIMEOUT_MS = 100;
export const TELEMETRY_LOCK_LEASE_MS = 30_000;
export const TELEMETRY_PRICE_TOKENS = 1_000_000;
// SA-094: bounded, explicit operator evaluations; no background model calls.
export const EVAL_MAX_REPETITIONS = 20;
export const EVAL_CRITERION_TIMEOUT_MS = 60_000;
export const EVAL_CRITERION_MAX_OUTPUT_BYTES = 1024 * 1024;
/** Verifier feedback is untrusted prompt data, never audit/telemetry content. */
export const VERIFIER_FEEDBACK_MAX_CHARS = 4000;
export const VERIFIER_FEEDBACK_MAX_LINES = 32;
export const VERIFIER_FEEDBACK_MAX_FILES = 32;
export const VERIFIER_FEEDBACK_FIELD_CHARS = 256;
export const VERIFIER_STYLE_RETRIES = 1;
// SA-027: bounded TaskDAG/FeatureSpec input and fixed-memory backup copying.
export const TASK_CLI_INPUT_BYTES = 1024 * 1024;
/** Saved reports add a bibliography and metadata to the model's bounded output. */
export const RESEARCH_REPORT_MAX_BYTES = 4 * 1024 * 1024;
/** 6x JSON escaping of a 1 MiB idea plus envelope; also fits full 64x64 layouts. */
export const WS_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
// Draft requests live in the checkout so the real --request validator can read them.
export const FEATURE_IDEAS_DIRECTORY = '.softwareagents/ideas';
export const FEATURE_IDEA_RESERVATIONS_DIRECTORY = 'softwareagents/idea-reservations';
export const FEATURE_ID_MIN = 1;
export const FEATURE_ID_MAX = 999;
export const FEATURE_ID_DIGITS = 3;
export const TASK_CLI_COPY_BUFFER_BYTES = 64 * 1024;
export const TASK_CLI_DEFAULT_KEEP = 7;
export const TASK_CLI_MAX_KEEP = 1000;

/** Claude Code refresh-lock contention only; other credential failures never retry. */
export const CLAUDE_OAUTH_REFRESH_RETRIES = 2;
export const CLAUDE_OAUTH_REFRESH_WAIT_MS = 30_000;
export const CLAUDE_OAUTH_REFRESH_CONTENTION = 'another Claude Code process is refreshing it';
export const CLAUDE_OAUTH_REFRESH_LOCK_FILE_NAME = '.oauth_refresh.lock';
export const CLAUDE_OAUTH_REFRESH_LOCK_MAX_BYTES = 1024;

/** Validation errors kept in an Architect/Requirements audit entry (count, chars each). */
export const VALIDATION_AUDIT_MAX_ERRORS = 20;
export const VALIDATION_AUDIT_MAX_ERROR_CHARS = 300;
/** Maximum automatic Developer reworks requested by Reviewer. */
export const REVIEW_MAX_REWORK_ROUNDS = 3;

/** Bound total QA command count; each verifier also has its existing timeout/output cap. */
export const QA_MAX_TEST_FILES = 32;
/** Recheck SA-026 leases without keeping a runner busy. */
export const FEATURE_RUN_POLL_MS = 1000;

/** QA runs whole task test files (e.g. worker.test.ts takes minutes on Windows); the
 * 60 s eval criterion budget is for single tests. Still bounded and tree-killed. */
export const QA_COMMAND_TIMEOUT_MS = 15 * 60_000;
/** SA-038: runtime quota rejection and transient transport recovery. */
export const EXECUTOR_QUOTA_FAILURE_THRESHOLD = 2;
export const QUOTA_BACKOFF_SECONDS = 300;
export const EXECUTOR_TRANSIENT_RETRIES = 2;
export const EXECUTOR_TRANSIENT_BACKOFF_MS = 1000;
export const EXECUTOR_TRANSIENT_MAX_BACKOFF_MS = 10000;
/** SA-037: wall-clock budget checks use the executor's verified cancellation path. */
export const USAGE_BUDGET_MINUTE_MS = 60_000;
export const USAGE_BUDGET_SECOND_MS = 1_000;
export const USAGE_BUDGET_POLL_MS = 1_000;
/** Maximum prefix read solely to resolve session ownership. */
export const PROJECT_SCOPE_TRANSCRIPT_READ_BYTES = 64 * 1024;
/** Maximum wait for a rendered office frame before design evidence is invalid. */
export const DESIGN_CANVAS_READY_TIMEOUT_MS = 15_000;
export const ZONES_CHECK_INTERVAL_MS = 60_000;
export const ZONES_GIT_TIMEOUT_MS = 10_000;
export const ZONES_GIT_BUFFER_BYTES = 4 * 1024 * 1024;
export const FLOW_P85 = 0.85;
/** Recent activity retained by both office board sources. */
export const BOARD_RECENT_EVENTS = 12;
/** SA-098: bounded human-approved learning context. */
export const LEARNING_RULE_CHARS = 300;
export const LEARNING_LIMIT = 5;
export const LEARNING_CONTEXT_CHARS = 2400;
export const CHARACTER_DETAIL_UNKNOWN = 'desconocido';
export const CHARACTER_DETAIL_TASK_PREFIX = 'tarea ';
export const CHARACTER_DETAIL_SECOND_MS = 1000;
// Human ingress: bounded, domain-separated proof of the live server's token.
export const OPERATOR_PROOF_PATH = '/api/operator/proof';
export const OPERATOR_PROOF_CONTEXT = 'pixel-agents:operator-proof:v1:';
export const OPERATOR_PROOF_NONCE_BYTES = 32;
export const OPERATOR_PROOF_TIMEOUT_MS = 2000;
export const OPERATOR_PROOF_MAX_BODY_CHARS = 1024;

/** Web scout inherits only OS essentials and Claude authentication/configuration. */
export const WEB_SCOUT_ENV_ALLOWLIST = [
  'PATH',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'USER',
  'LOGNAME',
  'LANG',
  'LANGUAGE',
  'TZ',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;
export const WEB_SCOUT_ENV_PREFIX_ALLOWLIST = ['ANTHROPIC_', 'LC_'] as const;
/** Independent CLI ceiling, including runs that stop reporting token usage. */
export const WEB_SCOUT_MAX_TURNS = 6;

/** Research policy belongs to Operator config, never collected content. */
export const RESEARCH_MODE_DEFAULTS = {
  quick: { maxSources: 4, maxTokens: 16000, maxSeconds: 180, maxCostUsd: 1 },
  deep: { maxSources: 24, maxTokens: 100000, maxSeconds: 1800, maxCostUsd: 10 },
} as const;
export const RESEARCH_LIMITS = {
  maxSources: 100,
  maxTokens: 1000000,
  maxSeconds: 1800,
  maxCostUsd: 1000,
} as const;
export const RESEARCH_QUESTION_CHARS = 4000;
export const RESEARCH_SEED_LIMIT = 100;
export const RESEARCH_REPORT_SUFFIX = '.research.json';
export const RESEARCH_MARKDOWN_SUFFIX = '.research.md';
export const RESEARCH_PRICE_TOKENS = 1000000;
/** API-equivalent estimate, deliberately conservative for input/cache tokens.
 * https://platform.claude.com/docs/en/about-claude/pricing */
export const RESEARCH_PRICES = { input: 6, output: 15 } as const;
/** Reserve a fixed share of the run cap before every model call. */
export const RESEARCH_BUDGET_HEADROOM_FRACTION = 0.2;
/** Ceiling on compiled system + context bytes for any individual research request. */
export const RESEARCH_REQUEST_MAX_BYTES = 128 * 1024;
/** Input admission estimate; reported runtime usage remains the final guard. */
export const RESEARCH_INPUT_ASCII_TOKENS_PER_BYTE = 1 / 2;
export const RESEARCH_INPUT_NON_ASCII_TOKENS_PER_BYTE = 1;
/** Prose and brain artifacts can quote a promise, so they never prove delivery. */
export const RESEARCH_NON_DELIVERY_PATH = /(^|\/)(docs|\.softwareagents)\/|\.(md|mdx|rst|txt)$/i;
/** Only parsed JS/TS implementation and tests are eligible; other languages fail closed. */
export const RESEARCH_DELIVERY_SOURCE_PATH = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
/** Additional allowance for provider framing, separate from runtime-authored input bytes. */
export const RESEARCH_REQUEST_OVERHEAD_TOKENS = 1024;
export const RESEARCH_COST_LABEL =
  'El tope es una estimación a precios API, no la facturación de la suscripción. Una sola respuesta puede superarlo ligeramente.';
export const RESEARCH_TOPICS = ['alternatives', 'technologies', 'risks', 'practices'] as const;
/** Reports live with operational feature artifacts, outside every branch tree. */
export const FEATURE_RESEARCH_DIRECTORY = 'softwareagents/feature-research';
export const FEATURE_RESEARCH_MAX_ITEMS = 1000;
export const FEATURE_RESEARCH_TEXT_CHARS = 4000;
export const FEATURE_RESEARCH_EVIDENCE_LIMIT = 12;
export const FEATURE_RESEARCH_EVIDENCE_NOTICE =
  'A citation is a pointer for human review, not proof of delivery or relevance. Code syntax can still cite unrelated or ineffective code. FeatureSpec, design and DAG lines are promises, not implementation evidence. Each item needs its own cited code; behavior and semantic relevance require human verification.';
export const FEATURE_RESEARCH_STATUSES = [
  'code_cited',
  'partial',
  'missing',
  'not verifiable',
] as const;

/** Ceiling for reading a process start time (PowerShell can take several seconds on a loaded Windows host). */
export const PROCESS_IDENTITY_TIMEOUT_MS = 15_000;

/** SA-055: bounded, observational GitHub CLI polling. */
export const PR_POLL_INTERVAL_MS = 60_000;
export const GH_PR_TIMEOUT_MS = 15_000;
export const GH_PR_MAX_BUFFER_BYTES = 1024 * 1024;
export const GH_PR_FIELDS =
  'state,isDraft,reviewDecision,statusCheckRollup,mergedAt,url,headRefName';
export const GH_FAILED_CONCLUSIONS = ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'];
export const GH_IGNORED_CONCLUSIONS = ['SKIPPED', 'NEUTRAL'];
export const PR_MONITOR_ACTOR = 'pr-monitor';
export const PR_CI_FAILURE_PREFIX = 'CI failed: ';
export const GH_STATUS_FAILURES = ['ERROR', 'FAILURE'];
export const PR_MAX_STRING_CHARS = 512;
export const PR_MAX_CHECKS = 256;
export const PR_MAX_TIMESTAMP_CHARS = 40;
export const PR_CI_REASON_CHARS = 2048;
export const PR_SHUTDOWN_TIMEOUT_MS = 5000;
// SA-111 only projects explicitly headed design sections. No inferred plan prose.
export const FEATURE_PLAN_HEADINGS = {
  tests: /^(?:pruebas|tests?|testing|test plan|plan de pruebas|validation|validación)$/i,
  ci: /^(?:ci|ci\/cd|continuous integration|integración continua)$/i,
  security: /^(?:security|seguridad)$/i,
  documentation: /^(?:documentation|documentación|docs)$/i,
} as const;
export const FEATURE_PLAN_REVISION_PATTERN = /^[a-f0-9]{64}$/;
/** Explicit negative rules only. No semantic inference of undeclared scope. */
export const FEATURE_PLAN_EXCLUSION_RULE =
  /^(?:no\b|nunca\b|sin\b|fuera de alcance\b|out of scope\b|not\b|never\b|must not\b|do not\b)/i;
// Project preparation writes only these repository-owned paths.
export const PROJECT_MANIFEST_PATH = '.softwareagents/project.yaml';
export const PROJECT_BRAIN_PATH = '.softwareagents/brain';
export const PROJECT_NAME_MAX_LENGTH = 120;
export const PROJECT_ID_HASH_LENGTH = 12;
export const PROJECT_ID_SLUG_LENGTH = 48;
export const PROJECT_LOCAL_REMOTE = 'local';
export const PROJECT_FALLBACK_BRANCH = 'main';
export const PROJECT_LEGACY_BRANCH = 'master';
export const OFFICE_BOOTSTRAP_TTL_MS = 60_000;
export const OFFICE_BOOTSTRAP_BYTES = 32;
export const OFFICE_BOOTSTRAP_RATE_LIMIT = 20;
export const OFFICE_BOOTSTRAP_RATE_WINDOW_MS = 60_000;
/** SA-155 additional managed-project lint and independent review allowance. */
export const PROJECT_QUALITY_LINT_CONFIG = 'eslint-rules/managed-project.config.mjs';
export const REVIEW_EXTRA_COST_RATIO = 0.2;
export const REVIEW_QUALITY_PASS_MARKER = 'review_pass=quality_structure';
