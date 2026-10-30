import { createHash } from 'crypto';
import * as fs from 'fs';

import { zonesOverlap } from './changeZones.js';
import { LEARNING_CONTEXT_CHARS, LEARNING_LIMIT, LEARNING_RULE_CHARS } from './constants.js';
import { containsExternalContent } from './externalContent.js';
import { featureIngressActor } from './featureIngress.js';
import type { FindingDecision } from './findingPrecision.js';
import { resolveInside } from './pathGuard.js';

export { LEARNING_CONTEXT_CHARS, LEARNING_LIMIT, LEARNING_RULE_CHARS } from './constants.js';
const ROOT = '.softwareagents/brain/learnings';
type State = 'proposed' | 'approved' | 'rejected';
export interface Learning {
  id: string;
  title: string;
  rule: string;
  zones: string[];
  role: string;
  taskType: string;
  origin: { task: string; execution: string; finding: number };
}
export interface LearningScope {
  zones: string[];
  role: string;
  taskType: string;
}
// Lessons are data. Fail closed on permission/policy language, including negated requests.
const AUTHORITY =
  /permission|permis|privileg|sandbox|polic[yií]|pol[ií]tic|autoriza|authoriz|allowlist|bypass|sudo|elevat|perfil|profile|acceso|access|secrets?/i;
export function validateLearning(value: unknown): Learning {
  const lesson = value as Learning;
  if (
    !lesson ||
    containsExternalContent(value) ||
    !/^[a-f0-9]{24}$/.test(lesson.id) ||
    typeof lesson.title !== 'string' ||
    !lesson.title.trim() ||
    lesson.title.length > 100 ||
    typeof lesson.rule !== 'string' ||
    !lesson.rule.trim() ||
    lesson.rule.length > LEARNING_RULE_CHARS ||
    !Array.isArray(lesson.zones) ||
    lesson.zones.length > 30 ||
    !lesson.zones.every(
      (z) =>
        typeof z === 'string' &&
        z.length <= 200 &&
        !z.includes('..') &&
        !z.includes('\\') &&
        !z.startsWith('/'),
    ) ||
    typeof lesson.role !== 'string' ||
    lesson.role.length > 80 ||
    typeof lesson.taskType !== 'string' ||
    lesson.taskType.length > 80 ||
    !lesson.origin ||
    typeof lesson.origin.task !== 'string' ||
    typeof lesson.origin.execution !== 'string' ||
    !Number.isSafeInteger(lesson.origin.finding) ||
    lesson.origin.finding < 0 ||
    AUTHORITY.test(JSON.stringify(value))
  )
    throw new Error('Invalid learning or permission/policy content');
  return {
    id: lesson.id,
    title: lesson.title,
    rule: lesson.rule,
    zones: lesson.zones,
    role: lesson.role,
    taskType: lesson.taskType,
    origin: lesson.origin,
  };
}
function file(root: string, state: State, id: string) {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid learning id');
  return resolveInside(root, `${ROOT}/${state}/${id}.json`);
}
export function listLearnings(root: string, state: State): Learning[] {
  const directory = resolveInside(root, `${ROOT}/${state}`);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .sort()
    .filter((n) => /^[a-f0-9]{24}\.json$/.test(n))
    .flatMap((n) => {
      try {
        const stored = JSON.parse(fs.readFileSync(file(root, state, n.slice(0, -5)), 'utf8'));
        if (state === 'approved' && (stored.decision !== 'approve' || stored.actor !== 'human'))
          return [];
        const lesson = validateLearning(stored);
        return lesson.id === n.slice(0, -5) ? [lesson] : [];
      } catch {
        return [];
      }
    });
}
export function decideLearning(
  root: string,
  id: string,
  decision: 'approve' | 'reject',
  reason?: string,
) {
  if (featureIngressActor() !== 'human')
    throw new Error('learning requires human ingress (SA-003)');
  const source = file(root, 'proposed', id);
  const lesson = validateLearning(JSON.parse(fs.readFileSync(source, 'utf8')));
  if (lesson.id !== id) throw new Error('Learning id mismatch');
  const target = file(root, decision === 'approve' ? 'approved' : 'rejected', id);
  fs.mkdirSync(resolveInside(root, `${ROOT}/${decision === 'approve' ? 'approved' : 'rejected'}`), {
    recursive: true,
  });
  fs.writeFileSync(
    target,
    JSON.stringify({ ...lesson, decision, actor: 'human', reason: reason ?? null }) + '\n',
    { flag: 'wx' },
  );
  fs.unlinkSync(source);
}
export function proposeLearnings(
  root: string,
  scope: LearningScope,
  task: string,
  execution: string,
  report: unknown,
  decisions: FindingDecision[] = [],
  context?: unknown,
) {
  if (containsExternalContent({ report, context })) return;
  const data = report as {
    findings?: {
      summary: string;
      suggestion?: string;
      file?: string;
      downgradeReasons?: string[];
    }[];
    defects?: { summary: string; downgradeReasons?: string[] }[];
  };
  for (const [index, finding] of (data.findings ?? data.defects ?? []).entries()) {
    const decision = decisions.find(
      (d) => d.execution === execution && d.index === index && d.task === task,
    );
    if (
      decision?.decision === 'reject' ||
      (finding.downgradeReasons?.length && decision?.decision !== 'accept')
    )
      continue;
    const raw = JSON.stringify({ task, execution, index });
    const id = createHash('sha256').update(raw).digest('hex').slice(0, 24);
    let lesson: Learning;
    try {
      // Validate before truncation so unsafe language cannot hide beyond the budget.
      if (AUTHORITY.test(JSON.stringify(finding))) continue;
      lesson = validateLearning({
        id,
        title: finding.summary.slice(0, 100),
        rule: ['Verify: ' + finding.summary, 'suggestion' in finding ? finding.suggestion : '']
          .filter(Boolean)
          .join(': ')
          .slice(0, LEARNING_RULE_CHARS),
        zones: 'file' in finding && finding.file ? [finding.file] : scope.zones,
        role: scope.role,
        taskType: scope.taskType,
        origin: { task, execution, finding: index },
      });
    } catch {
      continue;
    }
    if (['proposed', 'approved', 'rejected'].some((s) => fs.existsSync(file(root, s as State, id))))
      continue;
    // Proposals are best effort: a concurrent proposer (wx) or an unwritable Brain must
    // never fail the review/QA run that produced them.
    try {
      fs.mkdirSync(resolveInside(root, `${ROOT}/proposed`), { recursive: true });
      fs.writeFileSync(file(root, 'proposed', id), JSON.stringify(lesson) + '\n', { flag: 'wx' });
    } catch (error) {
      console.warn(`[Learnings] proposal ${id} not written: ${(error as Error).message}`);
    }
  }
}
export function selectLearnings(approved: readonly Learning[], scope: LearningScope): Learning[] {
  const ranked = approved
    .flatMap((value) => {
      try {
        const lesson = validateLearning(value);
        const score =
          (scope.zones.some((a) => lesson.zones.some((b) => zonesOverlap(a, b))) ? 4 : 0) +
          (lesson.role === scope.role ? 2 : 0) +
          (lesson.taskType === scope.taskType ? 1 : 0);
        return score ? [{ lesson, score }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.score - a.score || a.lesson.id.localeCompare(b.lesson.id));
  const selected: Learning[] = [];
  for (const { lesson } of ranked) {
    if (selected.length === LEARNING_LIMIT) break;
    if (JSON.stringify([...selected, lesson]).length <= LEARNING_CONTEXT_CHARS)
      selected.push(lesson);
  }
  return selected;
}
