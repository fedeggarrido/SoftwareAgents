import * as fs from 'fs';

import {
  auditContainmentDenial,
  claudeToolContainment,
  type ContainmentContext,
} from './agentContainment.js';

/** SA-062 PreToolUse hook, bundled to dist/hooks/containment-hook.js and registered only in the
 * runtime's private --settings. argv[2] is the Execution context file the Executor wrote outside
 * the worktree. Exit 2 blocks the tool in Claude Code; any other non-zero exit would let it run,
 * so every failure, including an unreadable context or input, ends in exit 2 (fail closed). */
const BLOCK = 2;

function block(reason: string): never {
  process.stderr.write(`[SoftwareAgents containment] Denied: ${reason}\n`);
  process.exit(BLOCK);
}

function readContext(file: string | undefined): ContainmentContext {
  if (!file) throw new Error('missing context');
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const context = value as Record<string, unknown>;
  for (const key of ['worktreeRoot', 'projectId', 'taskKey', 'executionId', 'executor'])
    if (typeof context?.[key] !== 'string' || !context[key]) throw new Error(`invalid ${key}`);
  return value as ContainmentContext;
}

function main(): void {
  let context: ContainmentContext;
  try {
    context = readContext(process.argv[2]);
  } catch {
    block('containment hook could not read its context.');
  }
  let hook: Record<string, unknown>;
  let input: string | undefined;
  try {
    input = fs.readFileSync(0, 'utf8');
    hook = JSON.parse(input) as Record<string, unknown>;
    if (!hook || typeof hook !== 'object' || Array.isArray(hook)) throw new Error('invalid input');
  } catch {
    let audited = true;
    try {
      auditContainmentDenial(
        context,
        {
          allowed: false,
          rule: 'unparseable',
          reason: 'Containment hook could not read its input.',
        },
        'unknown',
        input ?? null,
      );
    } catch {
      audited = false;
    }
    block(
      'containment hook could not read its input.' + (audited ? '' : ' (audit persistence failed)'),
    );
  }
  if (hook.hook_event_name !== undefined && hook.hook_event_name !== 'PreToolUse') return;
  const verdict = claudeToolContainment(hook.tool_name, hook.tool_input, context.worktreeRoot);
  if (verdict.allowed) return;
  let audited = true;
  try {
    auditContainmentDenial(context, verdict, String(hook.tool_name), hook.tool_input);
  } catch {
    audited = false;
  }
  block(
    `${verdict.reason} Push, PRs, git config/remote and .git/.claude writes are performed by the runtime only.` +
      (audited ? '' : ' (audit persistence failed)'),
  );
}

try {
  main();
} catch {
  block('containment hook failed.');
}
