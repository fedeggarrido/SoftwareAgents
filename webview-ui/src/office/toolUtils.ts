/** Map status prefixes back to tool names for animation selection */
const STATUS_TO_TOOL: Record<string, string> = {
  Reading: 'Read',
  Searching: 'Grep',
  Globbing: 'Glob',
  Fetching: 'WebFetch',
  'Searching web': 'WebSearch',
  Writing: 'Write',
  Editing: 'Edit',
  Running: 'Bash',
  Task: 'Task',
};

export function extractToolName(status: string): string | null {
  for (const [prefix, tool] of Object.entries(STATUS_TO_TOOL)) {
    if (status.startsWith(prefix)) return tool;
  }
  const first = status.split(/[\s:]/)[0];
  return first || null;
}

// ── Provider capabilities (tool taxonomy for rendering decisions) ────────────
// Populated once by the `providerCapabilities` postMessage after `webviewReady`.
// Modules classifying tools (character animation, subagent creation gate) read
// from here instead of hardcoding Claude-specific tool names.

const providerCaps: {
  readingTools: Set<string>;
  subagentToolNames: Set<string>;
} = {
  readingTools: new Set(),
  subagentToolNames: new Set(),
};

export function setProviderCapabilities(caps: {
  readingTools: string[];
  subagentToolNames: string[];
}): void {
  providerCaps.readingTools = new Set(caps.readingTools);
  providerCaps.subagentToolNames = new Set(caps.subagentToolNames);
}

export function isReadingToolName(name: string | null | undefined): boolean {
  return typeof name === 'string' && providerCaps.readingTools.has(name);
}

export function isSubagentToolName(name: string | null | undefined): boolean {
  return typeof name === 'string' && providerCaps.subagentToolNames.has(name);
}

// ── Provider labels (which CLI drives each character) ────────────────────────
// Sent by the server as `agentProviderLabel` for non-Claude agents (Codex).
// Anything without a label came through the Claude provider, the only other
// source the server has, so "Claude" is the truthful default.

const providerLabels = new Map<number, string>();

export function setProviderLabel(id: number, label: string): void {
  providerLabels.set(id, label);
}

export function clearProviderLabel(id: number): void {
  providerLabels.delete(id);
}

export function getProviderLabel(id: number): string {
  return providerLabels.get(id) ?? 'Claude';
}

// ── Roles in the agent company (Manager, Analista, DEV, QA...) ─────────────
// Sent by the server as `agentRole` once the session records who it is. No
// role yet means unknown, never a default: nothing is shown until it arrives.

export interface AgentRoleView {
  characterDetail?: import('../../../core/src/messages.js').CharacterDetail;
  label: string;
  department: string;
  detail?: string;
  tier?: 'economy' | 'standard' | 'deep';
  model?: string;
  effort?: string;
  selectionReason?: string;
}

/** Historical runtime choice; never inferred from the provider or current config. */
export function modelTierLabel(role: AgentRoleView | undefined): string | undefined {
  return role?.tier ? `${role.tier}${role.model ? ` · ${role.model}` : ''}` : undefined;
}

/**
 * Why this character runs what it runs (SA-091). Only the recorded launch
 * decision speaks; with executor controls active, a Session with no recorded
 * decision is labelled unmanaged rather than given an invented reason.
 */
export function assignmentReason(
  role: AgentRoleView | undefined,
  managedProject: boolean,
): string | undefined {
  if (role?.selectionReason) return role.selectionReason;
  if (role?.tier) return undefined;
  return managedProject ? 'Sesión externa · asignación no gestionada' : undefined;
}

const agentRoles = new Map<number, AgentRoleView>();

export function setAgentRole(id: number, role: AgentRoleView): void {
  agentRoles.set(id, role);
}

export function clearAgentRole(id: number): void {
  agentRoles.delete(id);
}

export function getAgentRole(id: number): AgentRoleView | undefined {
  return agentRoles.get(id);
}
