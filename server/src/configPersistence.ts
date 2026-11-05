import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ProjectOperatorConfig } from '../../core/src/project.js';
import { claudeConfigEnvironment } from './claudeConfig.js';
import {
  CONFIG_FILE_MODE,
  CONFIG_FILE_NAME,
  CONFIG_LOCK_DIR,
  CONFIG_LOCK_LEASE_MS,
  CONFIG_LOCK_NAME,
  CONFIG_LOCK_TIMEOUT_MS,
  LAYOUT_FILE_DIR,
} from './constants.js';
import { retryFileOperation } from './fileContention.js';
import { withLeaseLock } from './leaseLock.js';
import {
  MODEL_TIERS,
  ModelTierConfigError,
  tierPolicySchema,
  validateModelTiers,
} from './modelTiers.js';
import { researchLimitSchema } from './researchPolicy.js';
import { compileSchema, SchemaValidationError } from './schemaValidation.js';

export interface AdapterSettings {
  soundEnabled: boolean;
  lastSeenVersion: string;
  alwaysShowLabels: boolean;
  ghostHeadlessAgents: boolean;
  watchAllSessions: boolean;
  hooksInfoShown: boolean;
  showAreas: boolean;
  areaMappings: Record<string, string[]>;
}

/** All keys in AdapterSettings. Used by adapters to map `pixel-agents.foo` → `foo`.
 *  The hooks preference is NOT here: it is per-provider and machine-global
 *  (the hooks it governs live in one home-directory file per provider), so it
 *  lives beside `hooksConsent` at the config top level, not per namespace. */
export const ADAPTER_SETTING_KEYS = [
  'soundEnabled',
  'lastSeenVersion',
  'alwaysShowLabels',
  'ghostHeadlessAgents',
  'watchAllSessions',
  'hooksInfoShown',
  'showAreas',
  'areaMappings',
] as const;

export type AdapterSettingKey = (typeof ADAPTER_SETTING_KEYS)[number];

/** Namespaces = adapter identities sharing the same config.json file. */
export type ConfigNamespace = 'vscode' | 'standalone';

/** What the user answered a provider's consent ask with, durably. `granted` is recorded BEFORE the install writes, so
 *  it can exist with nothing on disk; `declined` means the ANSWER itself turned hooks off, the provenance a revised
 *  "Not Now" needs to know the preference is its to take back (a Settings toggle never records consent). Absent =
 *  unanswered, the ask is still open. */
export type HooksConsentState = 'granted' | 'declined';

export interface CompanyAutopilotConfig {
  command: string[];
  stateFile?: string;
}

export interface PixelAgentsConfig {
  /** Policies authored by the operator, keyed by Project id. */
  projects: Record<string, ProjectOperatorConfig>;
  /** Operator-owned commands, keyed by absolute workspace path. */
  companyAutopilot: Record<string, CompanyAutopilotConfig>;
  vscode: AdapterSettings;
  standalone: AdapterSettings;
  externalAssetDirectories: string[];
  /** Per-provider consent to modify that provider's settings file (Claude:
   *  ~/.claude/settings.json). Shared across surfaces — consent is per-human
   *  per-provider, not per-adapter. A provider absent from the map has never
   *  been answered. */
  hooksConsent: Record<string, HooksConsentState>;
  /** Per-provider hooks preference, machine-global for the same reason as the
   *  consent above. A provider absent from the map takes the default (true). */
  hooksEnabled: Record<string, boolean>;
}

const DEFAULT_ADAPTER_SETTINGS: AdapterSettings = {
  soundEnabled: true,
  lastSeenVersion: '',
  alwaysShowLabels: false,
  ghostHeadlessAgents: false,
  watchAllSessions: false,
  hooksInfoShown: false,
  showAreas: false,
  areaMappings: {},
};

const nonEmptyString = { type: 'string', minLength: 1, pattern: '^[^\\u0000]+$' };
const nonNegativeNumber = { type: 'number', minimum: 0 };
const concurrencyLimit = { type: 'integer', minimum: 0 };
const numberMap = (value: object) => ({ type: 'object', additionalProperties: value });
const validateProjectOperator = compileSchema<ProjectOperatorConfig>({
  type: 'object',
  additionalProperties: false,
  required: ['autonomyLevel', 'allowedExecutors'],
  properties: {
    autonomyLevel: { enum: ['A0', 'A1', 'A2', 'A3', 'A4'] },
    allowedExecutors: { type: 'array', items: nonEmptyString, uniqueItems: true },
    modelTiers: tierPolicySchema,
    developer: {
      type: 'object',
      additionalProperties: false,
      required: ['pushBranch'],
      properties: {
        pushBranch: {
          type: 'object',
          additionalProperties: false,
          required: ['enabled', 'remote'],
          properties: {
            enabled: { type: 'boolean' },
            remote: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]*$' },
          },
        },
      },
    },
    telemetry: {
      type: 'object',
      additionalProperties: false,
      properties: {
        otlp: {
          type: 'object',
          additionalProperties: false,
          required: ['enabled', 'endpoint'],
          properties: {
            enabled: { type: 'boolean' },
            endpoint: { type: 'string', maxLength: 2048, pattern: '^https?://[^\\s]+$' },
            headers: {
              type: 'object',
              maxProperties: 16,
              propertyNames: { pattern: '^[A-Za-z0-9-]{1,64}$' },
              additionalProperties: { type: 'string', maxLength: 4096, pattern: '^[^\\r\\n]*$' },
            },
          },
        },
        prices: {
          type: 'object',
          maxProperties: 256,
          additionalProperties: {
            type: 'object',
            additionalProperties: false,
            required: ['input', 'output'],
            properties: {
              input: nonNegativeNumber,
              output: nonNegativeNumber,
              cacheRead: nonNegativeNumber,
              cacheCreate: nonNegativeNumber,
            },
          },
        },
      },
    },
    executorLevels: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        ['claude', 'codex'].map((id) => [
          id,
          {
            type: 'array',
            maxItems: MODEL_TIERS.length,
            uniqueItems: true,
            items: { enum: [...MODEL_TIERS] },
          },
        ]),
      ),
    },
    protectedPaths: { type: 'array', items: nonEmptyString, uniqueItems: true },
    research: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...researchLimitSchema.properties,
        modes: {
          type: 'object',
          additionalProperties: false,
          properties: { quick: researchLimitSchema, deep: researchLimitSchema },
        },
        search: {
          type: 'object',
          additionalProperties: false,
          required: ['endpoint'],
          properties: { endpoint: nonEmptyString, apiKey: nonEmptyString },
        },
        reddit: {
          type: 'object',
          additionalProperties: false,
          required: ['clientId', 'clientSecret', 'userAgent'],
          properties: {
            clientId: nonEmptyString,
            clientSecret: nonEmptyString,
            userAgent: nonEmptyString,
          },
        },
      },
    },
    orchestrator: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxConcurrentTasks: { type: 'integer', minimum: 1 },
        designMaxRounds: { type: 'integer', minimum: 1 },
        designMaxTokens: { type: 'integer', minimum: 1 },
      },
    },
    binaryPaths: numberMap(nonEmptyString),
    executors: {
      type: 'object',
      additionalProperties: false,
      properties: {
        claude: {
          type: 'object',
          additionalProperties: false,
          properties: { configDir: nonEmptyString },
        },
      },
    },
    quotaThresholds: numberMap({ ...nonNegativeNumber, maximum: 100 }),
    concurrency: {
      type: 'object',
      additionalProperties: false,
      properties: { maxExecutions: concurrencyLimit, perExecutor: numberMap(concurrencyLimit) },
    },
    wip: {
      type: 'object',
      additionalProperties: false,
      properties: {
        running: { type: 'integer', minimum: 1 },
        review: { type: 'integer', minimum: 1 },
      },
    },
    budgets: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxTokens: concurrencyLimit,
        maxCostUsd: nonNegativeNumber,
        maxExecutionSeconds: nonNegativeNumber,
        maxExecutionMinutes: nonNegativeNumber,
        maxAttemptsPerTask: concurrencyLimit,
        maxTokensPerDay: concurrencyLimit,
      },
    },
    autopilot: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', pattern: '^[^\\u0000]*$' },
        },
        stateFile: nonEmptyString,
      },
    },
  },
});

/** The raw `projects` block each readConfig() result was parsed from, so a legacy
 *  writer only writes back the Projects it actually changed (see mergeProjects). */
const projectsAsRead = new WeakMap<
  Record<string, ProjectOperatorConfig>,
  Record<string, unknown>
>();

/** Defaults also merge against disk: a missing or unreadable file read as "no
 *  Projects" must not erase Projects another writer added meanwhile. */
function emptyProjects(): Record<string, ProjectOperatorConfig> {
  const projects: Record<string, ProjectOperatorConfig> = {};
  projectsAsRead.set(projects, {});
  return projects;
}

/** Invalid policies are rejected as a whole, never repaired into new authority. */
const rejectedProjects = new WeakMap<
  Record<string, ProjectOperatorConfig>,
  Record<string, { raw: unknown; error: Error }>
>();

export function projectConfigError(
  projects: Record<string, ProjectOperatorConfig>,
  id: string,
): Error | undefined {
  return rejectedProjects.get(projects)?.[id]?.error;
}

const warnedProjects = new Set<string>();

export function parseProjects(raw: unknown): Record<string, ProjectOperatorConfig> {
  const out: Record<string, ProjectOperatorConfig> = Object.create(null);
  const rejected: Record<string, { raw: unknown; error: Error }> = Object.create(null);
  rejectedProjects.set(out, rejected);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, policy] of Object.entries(raw)) {
    try {
      if (policy && typeof policy === 'object' && Object.hasOwn(policy, 'modelTiers')) {
        const candidate = policy as ProjectOperatorConfig;
        validateModelTiers(candidate.modelTiers);
        if (!validateProjectOperator(policy))
          throw new ModelTierConfigError(`Invalid Operator project ${id} with modelTiers`);
      }
      if (
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ||
        !validateProjectOperator(policy) ||
        (policy.autopilot && !policy.autopilot.command[0])
      )
        throw new SchemaValidationError([`Invalid Operator project ${id}`]);
      // Without a catalog the legacy selector has no tier to enforce these restrictions.
      if (!policy.modelTiers && policy.executorLevels && Object.keys(policy.executorLevels).length)
        throw new ModelTierConfigError(
          'Invalid Operator executorLevels: modelTiers catalog is required',
        );
      claudeConfigEnvironment(policy.executors?.claude?.configDir);
      out[id] = structuredClone(policy);
    } catch (error) {
      const diagnostic = error as Error;
      rejected[id] = { raw: structuredClone(policy), error: diagnostic };
      const warning = `[Pixel Agents] Rejected Operator project ${id}: ${diagnostic.message}`;
      if (!warnedProjects.has(warning)) {
        warnedProjects.add(warning);
        console.warn(warning);
      }
    }
  }
  return out;
}

function getConfigFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, CONFIG_FILE_NAME);
}

/** Windows workspace keys are case-insensitive; POSIX keys retain their case. */
export function companyAutopilotKey(workspace: string): string {
  const resolved = path.resolve(workspace);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Drop invalid authorizations entirely; never repair them into a different argv. */
export function parseCompanyAutopilot(raw: unknown): Record<string, CompanyAutopilotConfig> {
  const out: Record<string, CompanyAutopilotConfig> = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [workspace, value] of Object.entries(raw)) {
    if (!path.isAbsolute(workspace) || !value || typeof value !== 'object') continue;
    const { command, stateFile } = value as Partial<CompanyAutopilotConfig>;
    if (
      !Array.isArray(command) ||
      !command.length ||
      !command[0] ||
      !command.every((arg) => typeof arg === 'string' && !arg.includes('\0')) ||
      (stateFile !== undefined && typeof stateFile !== 'string')
    )
      continue;
    out[companyAutopilotKey(workspace)] = {
      command: [...command],
      ...(stateFile !== undefined ? { stateFile } : {}),
    };
  }
  return out;
}

/** Coerce a loose object into the per-provider consent map, dropping entries whose value is not exactly 'granted' or
 *  'declined'. */
function parseHooksConsent(raw: unknown): Record<string, HooksConsentState> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, HooksConsentState> = {};
  for (const [providerId, state] of Object.entries(raw as Record<string, unknown>)) {
    if (state === 'granted' || state === 'declined') out[providerId] = state;
  }
  return out;
}

/** Coerce a loose object into the per-provider hooks-preference map, dropping non-boolean values. */
function parseHooksEnabled(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [providerId, enabled] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof enabled === 'boolean') out[providerId] = enabled;
  }
  return out;
}

/**
 * Coerce a loose object into `Record<string, string[]>`, dropping any entries whose value is not an array of strings.
 * Returns `{}` if the input isn't an object. Used to defensively load folder→area mappings from config.json, which
 * may have been hand-edited or written by an older build.
 */
export function parseAreaMappings(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const [folder, labels] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof folder !== 'string') {
      continue;
    }
    if (!Array.isArray(labels)) {
      continue;
    }
    const filtered = labels.filter((l): l is string => typeof l === 'string');
    out[folder] = filtered;
  }
  return out;
}

/** Coerce a loose object into a valid AdapterSettings with defaults for missing/wrong-typed fields. */
function parseAdapterSettings(raw: unknown): AdapterSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<AdapterSettings>;
  return {
    soundEnabled:
      typeof obj.soundEnabled === 'boolean'
        ? obj.soundEnabled
        : DEFAULT_ADAPTER_SETTINGS.soundEnabled,
    lastSeenVersion:
      typeof obj.lastSeenVersion === 'string'
        ? obj.lastSeenVersion
        : DEFAULT_ADAPTER_SETTINGS.lastSeenVersion,
    alwaysShowLabels:
      typeof obj.alwaysShowLabels === 'boolean'
        ? obj.alwaysShowLabels
        : DEFAULT_ADAPTER_SETTINGS.alwaysShowLabels,
    ghostHeadlessAgents:
      typeof obj.ghostHeadlessAgents === 'boolean'
        ? obj.ghostHeadlessAgents
        : DEFAULT_ADAPTER_SETTINGS.ghostHeadlessAgents,
    watchAllSessions:
      typeof obj.watchAllSessions === 'boolean'
        ? obj.watchAllSessions
        : DEFAULT_ADAPTER_SETTINGS.watchAllSessions,
    hooksInfoShown:
      typeof obj.hooksInfoShown === 'boolean'
        ? obj.hooksInfoShown
        : DEFAULT_ADAPTER_SETTINGS.hooksInfoShown,
    showAreas:
      typeof obj.showAreas === 'boolean' ? obj.showAreas : DEFAULT_ADAPTER_SETTINGS.showAreas,
    areaMappings: parseAreaMappings(obj.areaMappings),
  };
}

export function readConfig(): PixelAgentsConfig {
  const filePath = getConfigFilePath();
  try {
    if (!fs.existsSync(filePath)) {
      return {
        vscode: { ...DEFAULT_ADAPTER_SETTINGS },
        standalone: { ...DEFAULT_ADAPTER_SETTINGS },
        externalAssetDirectories: [],
        hooksConsent: {},
        hooksEnabled: {},
        companyAutopilot: {},
        projects: emptyProjects(),
      };
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PixelAgentsConfig>;
    const projects = parseProjects(parsed.projects);
    projectsAsRead.set(
      projects,
      isPlainObject(parsed.projects) ? structuredClone(parsed.projects) : {},
    );
    return {
      vscode: parseAdapterSettings(parsed.vscode),
      standalone: parseAdapterSettings(parsed.standalone),
      externalAssetDirectories: Array.isArray(parsed.externalAssetDirectories)
        ? parsed.externalAssetDirectories.filter((d): d is string => typeof d === 'string')
        : [],
      hooksConsent: parseHooksConsent(parsed.hooksConsent),
      hooksEnabled: parseHooksEnabled(parsed.hooksEnabled),
      companyAutopilot: parseCompanyAutopilot(parsed.companyAutopilot),
      projects,
    };
  } catch (err) {
    console.error('[Pixel Agents] Failed to read config file:', err);
    return {
      vscode: { ...DEFAULT_ADAPTER_SETTINGS },
      standalone: { ...DEFAULT_ADAPTER_SETTINGS },
      externalAssetDirectories: [],
      hooksConsent: {},
      hooksEnabled: {},
      companyAutopilot: {},
      projects: emptyProjects(),
    };
  }
}

// ── Per-provider hooks consent + preference ─────────────────
// The provider id keys these maps (HookProvider.id — 'claude' today). All
// writers go through readConfig→writeConfig, so a hand-edited or older file
// degrades to "unanswered"/default rather than crashing.

/** What the user durably answered this provider's ask with, or 'unanswered'. */
export function getHooksConsent(providerId: string): HooksConsentState | 'unanswered' {
  return readConfig().hooksConsent[providerId] ?? 'unanswered';
}

/** Persist the one-time approval for modifying this provider's settings file. A grant REPLACING a decline also
 *  deletes that decline's hooks-off remnant in the same write: without it, an install that then FAILS leaves a grant
 *  beside the retracted hooks-off, and a later "Not Now" (which leaves the preference alone, since the grant never
 *  wrote it) ends at unanswered + hooks-off — an ask that never returns. A successful install persists hooks-on
 *  anyway, so this only changes the failure path. */
export function grantHooksConsent(providerId: string): void {
  const cfg = readConfig();
  if (cfg.hooksConsent[providerId] !== 'granted') {
    const replacingDecline = cfg.hooksConsent[providerId] === 'declined';
    cfg.hooksConsent[providerId] = 'granted';
    if (replacingDecline) delete cfg.hooksEnabled[providerId];
    writeConfig(cfg);
  }
}

/** Record a durable decline ("Don't Ask Again"): consent 'declined' AND hooks-off, in ONE readConfig→writeConfig
 *  cycle. They are one logical answer — split across two writes, a failed second leaves a state the answer disavows
 *  (a decline with the default-on preference, or a hooks-off with no provenance). */
export function recordHooksDecline(providerId: string): void {
  const cfg = readConfig();
  if (cfg.hooksConsent[providerId] !== 'declined' || cfg.hooksEnabled[providerId] !== false) {
    cfg.hooksConsent[providerId] = 'declined';
    cfg.hooksEnabled[providerId] = false;
    writeConfig(cfg);
  }
}

/** Un-record an answer AND restore the preference default in ONE cycle — the revised-notNow revert over a decline.
 *  Both keys go together so "never answered" and "answered and reverted" are indistinguishable on disk, and no
 *  partial-write order can leave a half-reverted answer. */
export function clearHooksAnswer(providerId: string): void {
  const cfg = readConfig();
  if (providerId in cfg.hooksConsent || providerId in cfg.hooksEnabled) {
    delete cfg.hooksConsent[providerId];
    delete cfg.hooksEnabled[providerId];
    writeConfig(cfg);
  }
}

/** Un-record an answer entirely, so the ask genuinely returns. Used when the
 *  user walks the Intro back from its closing step and revises an earlier
 *  answer down to "Not Now": whatever that answer left (a grant, a decline)
 *  must go, or the consent gate reads it as asked-and-answered forever.
 *  Callers only clear a grant after any uninstall verifiably landed. */
export function clearHooksConsent(providerId: string): void {
  const cfg = readConfig();
  if (providerId in cfg.hooksConsent) {
    delete cfg.hooksConsent[providerId];
    writeConfig(cfg);
  }
}

/** The per-provider hooks preference. Absent = the default, true. */
export function getHooksEnabled(providerId: string): boolean {
  return readConfig().hooksEnabled[providerId] ?? true;
}

export function setHooksEnabled(providerId: string, enabled: boolean): void {
  const cfg = readConfig();
  if (cfg.hooksEnabled[providerId] !== enabled) {
    cfg.hooksEnabled[providerId] = enabled;
    writeConfig(cfg);
  }
}

/** Restore the provider's preference to its default (true) by REMOVING the key. Deleting rather than writing `true`
 *  keeps "never answered" and "answered and reverted" indistinguishable on disk. */
export function clearHooksEnabled(providerId: string): void {
  const cfg = readConfig();
  if (providerId in cfg.hooksEnabled) {
    delete cfg.hooksEnabled[providerId];
    writeConfig(cfg);
  }
}

/** Called on extension uninstall: return every hooks-related choice to factory state — all providers' consent and
 *  preferences cleared, hooksInfoShown back to default in both namespaces. Those choices belonged to an installation
 *  that no longer exists, so a future install starts from the first-run experience rather than inheriting a stale
 *  hooks-off that would skip the ask forever. */
export function resetHooksConfig(): void {
  const cfg = readConfig();
  cfg.hooksConsent = {};
  cfg.hooksEnabled = {};
  for (const ns of ['vscode', 'standalone'] as const) {
    cfg[ns].hooksInfoShown = DEFAULT_ADAPTER_SETTINGS.hooksInfoShown;
  }
  writeConfig(cfg);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Object keys sorted at every depth; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value))
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

/** The config file exists but cannot be used as a base for a write. Never replaced by defaults. */
export class ConfigReadError extends Error {}

/** Raw parsed config.json, `null` when absent. Throws ConfigReadError on anything
 *  else: a read failure must never become `{}` that a writer then persists. */
export function readRawConfig(): Record<string, unknown> | null {
  let text: string;
  try {
    text = retryFileOperation(() => {
      try {
        return fs.readFileSync(getConfigFilePath(), 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null as unknown as string;
        throw error;
      }
    });
  } catch (error) {
    throw new ConfigReadError(`Cannot read config file: ${(error as Error).message}`);
  }
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigReadError('Config file is not valid JSON');
  }
  if (!isPlainObject(parsed)) throw new ConfigReadError('Config file is not a JSON object');
  return parsed;
}

/** Whole-file mutex that every config writer takes (legacy writeConfig included). */
export function withConfigLock<T>(action: () => T): T {
  return withLeaseLock(
    {
      dir: path.join(os.homedir(), LAYOUT_FILE_DIR, CONFIG_LOCK_DIR),
      name: CONFIG_LOCK_NAME,
      timeoutMs: CONFIG_LOCK_TIMEOUT_MS,
      leaseMs: CONFIG_LOCK_LEASE_MS,
      label: 'Config',
    },
    action,
  );
}

/** Under withConfigLock. Unique exclusive temporary, fsync, rename; THROWS on any failure. */
export function writeRawConfigFile(value: Record<string, unknown>): void {
  const filePath = getConfigFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const fd = fs.openSync(tmpPath, 'wx', CONFIG_FILE_MODE);
    created = true;
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (process.platform !== 'win32') fs.chmodSync(tmpPath, CONFIG_FILE_MODE);
    retryFileOperation(() => fs.renameSync(tmpPath, filePath));
    created = false;
  } finally {
    if (created) fs.rmSync(tmpPath, { force: true });
  }
}

/** Projects to persist for a legacy write: what is on disk now, plus only the
 *  entries this caller changed since its readConfig(). A concurrent Operator
 *  change (SA-088) is never reverted by a stale settings write. */
function mergeProjects(
  projects: Record<string, ProjectOperatorConfig>,
  disk: Record<string, unknown> | null,
): Record<string, unknown> {
  const rejected = rejectedProjects.get(projects) ?? {};
  const asRead = projectsAsRead.get(projects);
  if (!asRead)
    return {
      ...Object.fromEntries(Object.entries(rejected).map(([id, entry]) => [id, entry.raw])),
      ...projects,
    };
  const out: Record<string, unknown> = isPlainObject(disk?.projects) ? { ...disk.projects } : {};
  for (const id of new Set([...Object.keys(asRead), ...Object.keys(projects)])) {
    const mine = Object.hasOwn(projects, id)
      ? projects[id]
      : Object.hasOwn(rejected, id)
        ? asRead[id]
        : undefined;
    if (canonicalJson(mine) === canonicalJson(asRead[id])) continue;
    if (mine === undefined) delete out[id];
    else out[id] = mine;
  }
  return out;
}

/** Settings/consent writer. Takes the config lock and refuses to write over a file
 *  it cannot read (it would otherwise persist defaults over the operator's file).
 *  Failures are logged, not thrown: callers re-read to learn the outcome. */
export function writeConfig(config: PixelAgentsConfig): void {
  try {
    withConfigLock(() => {
      const disk = readRawConfig();
      writeRawConfigFile({ ...config, projects: mergeProjects(config.projects, disk) });
    });
  } catch (err) {
    console.error('[Pixel Agents] Failed to write config file:', err);
  }
}
