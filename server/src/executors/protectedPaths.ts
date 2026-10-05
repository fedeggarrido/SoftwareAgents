import { execFileSync } from 'child_process';

import type { ProjectOperatorConfig } from '../../../core/src/project.js';
import { AuditLog } from '../auditLog.js';
import { evaluatePolicy, type PolicyActor, type PolicyDecision } from '../policy.js';

export const DEFAULT_PROTECTED_PATHS = Object.freeze([
  '.github/**',
  '.claude/**',
  // Files the CLIs load by themselves as configuration or instructions, outside the
  // untrusted-data boundary (SA-QA-4): a Developer must not be able to plant them.
  '.codex/**',
  '.agents/**',
  '.mcp.json',
  'AGENTS.md',
  '**/AGENTS.md',
  'CLAUDE.md',
  '**/CLAUDE.md',
  '.softwareagents/project.yaml',
  '.softwareagents/agents/**',
  'agents/templates/**',
  'CODEOWNERS',
  '**/CODEOWNERS',
  'esbuild.js',
  'scripts/**',
]);

function matches(file: string, pattern: string): boolean {
  // Protect directory entries too (e.g. replacing .github with a symlink).
  if (pattern.endsWith('/**') && file.toLowerCase() === pattern.slice(0, -3).toLowerCase())
    return true;
  const expression = pattern
    .split(/(\*\*|\*)/)
    .map((part) =>
      part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${expression}$`, 'i').test(file);
}

export interface ProtectedPathsOptions {
  cwd: string;
  base: string;
  /** Check the exact index to be committed, relative to the merge base. */
  staged?: boolean;
  operator: ProjectOperatorConfig;
  projectId: string;
  taskKey?: string;
  executionId?: string;
  /** Only an authenticated, explicit human request may supply human here.
   * Never derive this from a brief, repository, or an execution launch. */
  actor?: PolicyActor;
}

/** Reusable before runtime commit, push, or human integration. Git/read/audit
 * errors throw: callers must not proceed when the guard cannot establish safety.
 * No repository configuration is read for the protected list. */
export function guardProtectedPaths(options: ProtectedPathsOptions): {
  paths: string[];
  decision: PolicyDecision;
} {
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: options.cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
  const base = git([
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${options.base}^{commit}`,
  ]).trim();
  const mergeBase = git(['merge-base', base, 'HEAD']).trim();
  const target = options.staged ? ['--cached', mergeBase] : [`${base}...HEAD`];
  const files = git(['diff', '--name-only', '-z', '--no-renames', ...target, '--'])
    .split('\0')
    .filter(Boolean);
  const patterns = [...DEFAULT_PROTECTED_PATHS, ...(options.operator.protectedPaths ?? [])];
  const paths = files.filter((file) => {
    if (patterns.some((pattern) => matches(file, pattern))) return true;
    if (!/(^|\/)package\.json$/i.test(file)) return false;
    const readScripts = (revision: string) => {
      // A missing side (addition/deletion) has no scripts. Other errors fail closed.
      const entries = git(['ls-tree', '-z', revision, '--', file]);
      if (!entries) return undefined;
      const value: unknown = JSON.parse(git(['show', `${revision}:${file}`]));
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid package.json');
      return (value as Record<string, unknown>).scripts;
    };
    const before = readScripts(mergeBase);
    // write-tree captures the index without committing or executing hooks.
    const after = readScripts(options.staged ? git(['write-tree']).trim() : 'HEAD');
    const canonical = (value: unknown): string => {
      if (value && typeof value === 'object' && !Array.isArray(value))
        return JSON.stringify(
          Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
        );
      return JSON.stringify(value) ?? 'undefined';
    };
    return canonical(before) !== canonical(after);
  });
  const actor = options.actor ?? 'system';
  const decision: PolicyDecision = paths.length
    ? evaluatePolicy('touch_protected_path', actor, options.operator.autonomyLevel)
    : { outcome: 'allow', reason: 'No protected paths changed.' };
  if (paths.length)
    new AuditLog().append({
      action: 'touch_protected_path',
      resourceType: 'repository',
      resourceId: base,
      projectId: options.projectId,
      actorType: actor,
      actorId: actor === 'human' ? 'operator' : 'runtime',
      taskKey: options.taskKey ?? null,
      executionId: options.executionId ?? null,
      policyDecision: decision,
      riskLevel: 'high',
      input: { base, staged: options.staged ?? false, paths },
      outcome: { status: decision.outcome, detail: JSON.stringify(paths) },
    });
  return { paths, decision };
}
