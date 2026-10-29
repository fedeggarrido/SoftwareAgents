import * as fs from 'fs';
import * as path from 'path';

import { AuditLog } from '../auditLog.js';
import { evaluatePolicy, type PolicyAction, type PolicyDecision } from '../policy.js';
import type { ExecutorId } from './executor.js';

/** SA-062: the runtime pushes and opens PRs, never the agent. These rules are unconditional:
 * no autonomy level, AgentSpec or repository content relaxes them. Defense in depth beside the
 * neutralized pushurl (SA-032) and the protected-path guard (SA-063); not an OS sandbox (SA-058). */
export type ContainmentRule =
  | 'git_push'
  | 'git_config'
  | 'git_remote'
  | 'gh'
  | 'protected_write'
  | 'outside_worktree'
  | 'unparseable';

export type ContainmentVerdict =
  { allowed: true } | { allowed: false; rule: ContainmentRule; reason: string };

/** Push-capable plumbing counts as push: it reaches a remote without `git push`. */
const GIT_SUBCOMMANDS: Readonly<Record<string, ContainmentRule>> = {
  push: 'git_push',
  'send-pack': 'git_push',
  'http-push': 'git_push',
  config: 'git_config',
  remote: 'git_remote',
};
/** Path segments an agent may never write through, at any depth. */
const PROTECTED_SEGMENTS: readonly string[] = ['.git', '.claude'];
/** Global git config files: writing them changes git config without `git config`. */
const PROTECTED_BASENAMES: readonly string[] = ['.gitconfig'];
const CLAUDE_WRITE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Edit: ['file_path'],
  Write: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
};
const CLAUDE_SHELL_TOOLS: readonly string[] = ['Bash', 'PowerShell'];

/** Claude treats a hook timeout as a non-blocking error (the tool runs), so this must exceed
 * node startup plus the audit lock wait (AUDIT_LOCK_TIMEOUT_MS). The Executor tripwire covers
 * a timeout anyway. */
export const CONTAINMENT_HOOK_TIMEOUT_SEC = 30;

const deny = (rule: ContainmentRule, reason: string): ContainmentVerdict => ({
  allowed: false,
  rule,
  reason,
});

/** Conservative, not a shell parser: quotes and escapes are dropped so `"git" 'push'` still
 * matches, and a forbidden subcommand anywhere after `git` in the same simple command denies
 * (`git -C x push`, `env git push`, `bash -lc 'git push'`). Rare false positives such as
 * `git log --grep push` are accepted. Dynamic subcommands and inline aliases fail closed;
 * arbitrary shell evaluation still needs the sandbox and the protected-path guard. */
export function commandContainment(command: string): ContainmentVerdict {
  const lower = command.toLowerCase().replace(/["']/g, '');
  // Preserve backticks and the `$` prefix of substitutions when inspecting the verb.
  for (const variant of [lower.replace(/\\/g, ''), lower.replace(/\\/g, '/')]) {
    for (const segment of variant.split(/[;&|()\r\n]/)) {
      const words = segment.split(/\s+/).filter(Boolean);
      for (let index = 0; index < words.length; index++) {
        if (path.posix.basename(words[index]).replace(/\.exe$/, '') !== 'git') continue;
        const args = words.slice(index + 1);
        for (let arg = 0; arg < args.length; arg++) {
          const word = args[arg];
          if (/^-c(?:alias\.|$)/.test(word) || /^--config-env(?:=|$)/.test(word)) {
            const setting =
              word === '-c' || word === '--config-env'
                ? args[arg + 1]
                : word.replace(/^(-c|--config-env=)/, '');
            if (setting?.startsWith('alias.'))
              return deny('git_config', 'Inline git aliases are reserved to the runtime.');
          }
          // Skip options and their values to inspect only the subcommand, not ordinary args
          // such as `git diff -- "$file"` or `git log --format="$format"`.
          if (['-c', '--config-env', '--git-dir', '--work-tree', '--namespace'].includes(word)) {
            arg++;
            continue;
          }
          if (word.startsWith('-')) continue;
          if (/[$`]|%[^%]+%/.test(word))
            return deny('unparseable', 'Dynamic git subcommands cannot be contained.');
          break;
        }
      }
    }
  }
  // Backslash is a POSIX escape (`g\it`) and a Windows separator (`C:\Git\cmd\git.exe`): try both.
  const segments = [lower.replace(/\\/g, ''), lower.replace(/\\/g, '/')].flatMap((variant) =>
    variant.split(/[;&|()`\r\n]/),
  );
  const program = (word: string) => path.posix.basename(word).replace(/\.exe$/, '');
  for (const segment of segments) {
    const words = segment.split(/[\s<>{}]+/).filter(Boolean);
    for (let index = 0; index < words.length; index++) {
      const name = program(words[index]);
      if (name === 'gh') return deny('gh', 'GitHub CLI is reserved to the runtime.');
      if (name !== 'git') continue;
      for (const word of words.slice(index + 1)) {
        const rule = Object.hasOwn(GIT_SUBCOMMANDS, word) ? GIT_SUBCOMMANDS[word] : undefined;
        if (rule) return deny(rule, `git ${word} is reserved to the runtime.`);
      }
    }
  }
  return { allowed: true };
}

/** Best-effort detection of evident shell writes, not a shell/interpreter parser. A write
 * primitive plus a literal protected target fails closed, even if that path is a source or
 * appears in a script string. Computed paths and indirect scripts remain a residual risk. */
function shellWriteContainment(command: string, worktreeRoot: string): ContainmentVerdict {
  const write =
    />/.test(command) ||
    /(?:^|[\s;&|"'(/\\])(?:set-content|out-file|add-content|tee|cp|mv|copy|move|copy-item|move-item)(?:\.exe)?\s/i.test(
      command,
    ) ||
    (/(?:^|[\s;&|"'(/\\])(?:node|python[\d.]*|py)(?:\.exe)?\s.*?(?:-e|--eval|-c)\b/i.test(
      command,
    ) &&
      /writeFile|appendFile|write_text|write_bytes|\.write\s*\(|open\s*\([^\r\n]*["'][wax][^"']*["']|rename|unlink|mkdir|truncate|copyFile/i.test(
        command,
      ));
  if (!write) return { allowed: true };
  const targets = command
    .replace(/["']/g, '')
    .split(/[\s`(){};,|&<>=]+/)
    .filter(Boolean);
  for (const target of targets) {
    // A literal protected path is forbidden even when it names a directory outside the
    // worktree (pathContainment would classify that as outside_worktree first).
    if (protectedRelative(target))
      return deny(
        'protected_write',
        `protected_write: detected ${JSON.stringify(target.match(/(?:\.gitconfig|\.git|\.claude)(?=[/\\]|$)/i)?.[0] ?? 'protected path')}; usa apply_patch/Edit para escribir ficheros. Protected paths remain forbidden.`,
      );
    const verdict = pathContainment(target, worktreeRoot);
    if (
      !verdict.allowed &&
      (verdict.rule === 'protected_write' ||
        (verdict.rule === 'outside_worktree' && /^(?:\.\.[/\\]|[/\\]|[a-z]:[/\\])/i.test(target)))
    )
      return deny(
        verdict.rule,
        `${verdict.rule}: detected ${JSON.stringify(target)}; usa apply_patch/Edit para escribir ficheros dentro del worktree. Protected paths remain forbidden.`,
      );
  }
  return { allowed: true };
}

function shellContainment(command: string, worktreeRoot: string): ContainmentVerdict {
  const verdict = commandContainment(command);
  return verdict.allowed ? shellWriteContainment(command, worktreeRoot) : verdict;
}

/** Windows ignores trailing dots/spaces and maps `name::$DATA` streams to `name`; folded on
 * every platform so the check cannot depend on where it runs. */
function normalizeSegment(segment: string): string {
  return segment
    .split(':')[0]
    .replace(/[. ]+$/, '')
    .toLowerCase();
}

function protectedRelative(relative: string): boolean {
  const segments = relative
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(normalizeSegment);
  return (
    segments.some((segment) => PROTECTED_SEGMENTS.includes(segment)) ||
    PROTECTED_BASENAMES.includes(segments.at(-1) ?? '')
  );
}

function outside(relative: string): boolean {
  return (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    // Different Windows drive or UNC root.
    /^[a-zA-Z]:/.test(relative)
  );
}

/** Resolve through the deepest existing ancestor: a symlink or junction inside the worktree
 * pointing at `.git` or elsewhere is judged by where the write would really land. */
function realTarget(target: string): string {
  let existing = target;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...rest.reverse());
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      rest.push(path.basename(existing));
      existing = parent;
    }
  }
}

export function pathContainment(file: string, worktreeRoot: string): ContainmentVerdict {
  if (!file || file.includes('\0')) return deny('unparseable', 'Invalid target path.');
  const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const root = path.resolve(worktreeRoot);
  const target = path.resolve(root, file);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    return deny('unparseable', 'The assigned worktree cannot be resolved.');
  }
  for (const [base, candidate] of [
    [root, target],
    [realRoot, realTarget(target)],
  ]) {
    const relative = path.relative(fold(base), fold(candidate));
    if (outside(relative))
      return deny('outside_worktree', 'Writes are confined to the assigned worktree.');
    if (protectedRelative(relative))
      return deny(
        'protected_write',
        'Writes to .git/** and .claude/** are reserved to the runtime.',
      );
  }
  return { allowed: true };
}

/** Claude PreToolUse input: tool name plus tool_input. Unknown tools pass (the CLI's own
 * --tools allowlist already removed them); a known tool with a malformed input is denied. */
export function claudeToolContainment(
  toolName: unknown,
  input: unknown,
  worktreeRoot: string,
): ContainmentVerdict {
  if (typeof toolName !== 'string') return deny('unparseable', 'Missing tool name.');
  const fields = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (CLAUDE_SHELL_TOOLS.includes(toolName))
    return typeof fields.command === 'string'
      ? shellContainment(fields.command, worktreeRoot)
      : deny('unparseable', 'Missing shell command.');
  if (Object.hasOwn(CLAUDE_WRITE_TOOLS, toolName)) {
    for (const key of CLAUDE_WRITE_TOOLS[toolName]) {
      const file = fields[key];
      if (typeof file !== 'string') return deny('unparseable', `Missing ${key}.`);
      const verdict = pathContainment(file, worktreeRoot);
      if (!verdict.allowed) return verdict;
    }
  }
  return { allowed: true };
}

/** Codex exec items: shell commands and applied patches. */
export function codexItemContainment(item: unknown, worktreeRoot: string): ContainmentVerdict {
  if (!item || typeof item !== 'object') return { allowed: true };
  const fields = item as Record<string, unknown>;
  if (fields.type === 'command_execution')
    return typeof fields.command === 'string'
      ? shellContainment(fields.command, worktreeRoot)
      : Array.isArray(fields.command)
        ? shellContainment(fields.command.map(String).join(' '), worktreeRoot)
        : deny('unparseable', 'Missing shell command.');
  if (fields.type === 'file_change') {
    const changes = Array.isArray(fields.changes) ? fields.changes : [];
    for (const change of changes) {
      const file = (change as { path?: unknown } | null)?.path;
      if (typeof file !== 'string') return deny('unparseable', 'Missing changed path.');
      const verdict = pathContainment(file, worktreeRoot);
      if (!verdict.allowed) return verdict;
    }
  }
  return { allowed: true };
}

/** Commands bypass the runtime's push/remote control; paths are protected paths. */
const RULE_ACTIONS: Readonly<Record<ContainmentRule, PolicyAction>> = {
  git_push: 'bypass_permissions',
  git_config: 'bypass_permissions',
  git_remote: 'bypass_permissions',
  gh: 'bypass_permissions',
  protected_write: 'touch_protected_path',
  outside_worktree: 'touch_protected_path',
  unparseable: 'touch_protected_path',
};

/** policy.ts decides for the agent actor. Both actions are level-independent for agents
 * (bypass_permissions: deny; touch_protected_path: require_human, a rejection until SA-028),
 * so A0 is passed; containment never yields allow even if the policy table changes. */
export function containmentDecision(rule: ContainmentRule): PolicyDecision {
  const decision = evaluatePolicy(RULE_ACTIONS[rule], 'agent', 'A0');
  return decision.outcome === 'allow'
    ? { outcome: 'deny', reason: `Agent containment (${rule}) is unconditional.` }
    : decision;
}

export interface ContainmentContext {
  worktreeRoot: string;
  projectId: string;
  taskKey: string;
  executionId: string;
  executor: ExecutorId;
}

/** Throws when the entry cannot be persisted; callers deny regardless. Only the rule and the
 * hash of the attempted input are stored: commands may carry credentials in URLs. */
export function auditContainmentDenial(
  context: ContainmentContext,
  verdict: Extract<ContainmentVerdict, { allowed: false }>,
  toolName: string,
  input: unknown,
): void {
  const policyDecision = containmentDecision(verdict.rule);
  new AuditLog().append({
    projectId: context.projectId,
    actorType: 'agent',
    actorId: context.executor,
    action: 'agent_containment',
    resourceType: 'tool',
    resourceId: toolName,
    policyDecision,
    riskLevel: 'high',
    taskKey: context.taskKey,
    executionId: context.executionId,
    input: { tool: toolName, input },
    outcome: { status: 'denied', detail: verdict.rule, reason: verdict.reason },
  });
}
