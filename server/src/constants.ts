// ── JSONL File Watching ─────────────────────────────────────
export const JSONL_POLL_INTERVAL_MS = 1000;
/** Bounded inter-process audit lock contention, including Windows pending unlink. */
export const AUDIT_LOCK_TIMEOUT_MS = 5_000;
export const AUDIT_LOCK_POLL_MS = 10;
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

// ── Layout/Config Persistence ──────────────────────────────
export const LAYOUT_FILE_DIR = '.pixel-agents';
export const LAYOUT_FILE_NAME = 'layout.json';
export const LAYOUT_FILE_POLL_INTERVAL_MS = 2000;
export const LAYOUT_REVISION_KEY = 'layoutRevision';
export const CONFIG_FILE_NAME = 'config.json';
export const CONFIG_FILE_MODE = 0o600;

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
/** Retry failed process-tree termination for this long; an unconfirmed close never finishes. */
export const EXECUTOR_TERMINATION_TIMEOUT_MS = 5_000;
export const EXECUTOR_TERMINATION_RETRY_MS = 250;
/** Every taskkill gets a full budget, even near the end of the retry window. */
export const EXECUTOR_TASKKILL_TIMEOUT_MS = 2000;

/** Dead office publications are retained for quota diagnostics for one day. */
export const MACHINE_CAPACITY_RETENTION_S = 24 * 60 * 60;
