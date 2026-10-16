import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { stringify } from 'yaml';

import * as featureSchema from '../../core/schemas/feature-spec.schema.json';
import type { FeatureSpec } from '../../core/src/featureSpec.js';
import { readTaskInput, taskDirectory, taskPath } from './commands/taskFiles.js';
import { TASK_CLI_INPUT_BYTES } from './constants.js';
import { parseFeatureSpec } from './featureSpec.js';
import { SchemaValidationError } from './schemaValidation.js';
import type { WorkStore } from './workstore/WorkStore.js';

export interface RequirementsRequest {
  key: string;
  request: string;
  revision?: {
    spec: FeatureSpec;
    gitSha: string;
    decisionId: string;
    answers: string;
  };
}

export function requirementsBrief(input: RequirementsRequest, errors: string[] = []): string {
  return JSON.stringify({
    request: input.request,
    featureKey: input.key,
    ...(input.revision
      ? {
          currentSpec: input.revision.spec,
          answers: input.revision.answers,
          nextVersion: nextRequirementsVersion(input.revision.spec.version),
        }
      : {}),
    contract: featureSchema,
    validationErrors: errors,
  });
}

/** Includes ignored/untracked files: git status alone misses ignored writes.
 * This is a final guard, not an OS sandbox; native tools remain read-only (SA-062). */
export function requirementsSnapshot(cwd: string): Map<string, string> {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  })
    .split('\0')
    .filter(Boolean);
  const result = new Map<string, string>();
  const directories = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (directory === cwd && entry.name === '.git') continue;
      const target = path.join(directory, entry.name);
      const relative = path.relative(cwd, target).replaceAll('\\', '/');
      taskPath(cwd, relative);
      if (entry.isDirectory()) {
        result.set(`${relative}/`, 'directory');
        directories(target);
      }
    }
  };
  directories(cwd);
  for (const file of new Set(files)) {
    const target = taskPath(cwd, file);
    if (!fs.existsSync(target)) continue;
    const stat = fs.lstatSync(target);
    if (!stat.isFile()) throw new Error('Requirements containment: non-regular file');
    result.set(
      file,
      `${stat.mode}:${createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`,
    );
  }
  return result;
}

export function guardRequirementsWrites(
  cwd: string,
  before: Map<string, string>,
  allowed?: string | string[],
) {
  const paths = typeof allowed === 'string' ? [allowed] : (allowed ?? []);
  const after = requirementsSnapshot(cwd);
  for (const file of new Set([...before.keys(), ...after.keys()]))
    if (
      !paths.includes(file) &&
      // Only the runtime may create missing parents of its fixed artifact.
      !(
        file.endsWith('/') &&
        paths.some((target) => target.startsWith(file)) &&
        after.get(file) === 'directory'
      ) &&
      before.get(file) !== after.get(file)
    )
      throw new Error('Requirements containment: unauthorized write outside runtime artifact');
}

export function validateRequirements(source: string, key: string): FeatureSpec {
  if (Buffer.byteLength(source) > TASK_CLI_INPUT_BYTES)
    throw new SchemaValidationError(['FeatureSpec exceeds 1 MiB limit']);
  const spec = parseFeatureSpec(source, `${key}.yaml`);
  const errors: string[] = [];
  if (spec.key !== key) errors.push('/key: must match requested Feature ID');
  if (spec.status !== 'draft') errors.push('/status: Requirements must return draft');
  if (new Set(spec.acceptance.map((ac) => ac.id)).size !== spec.acceptance.length)
    errors.push('/acceptance: duplicate criterion ids');
  spec.acceptance.forEach((ac, i) => {
    if (!ac.ears) errors.push(`/acceptance/${i}/ears: required for Requirements output`);
  });
  if (errors.length) throw new SchemaValidationError(errors);
  serializeRequirements(spec);
  return spec;
}

export function requirementsDocPath(brain: string, key: string): string {
  if (!/^FEAT-\d{3}$/.test(key)) throw new Error('Invalid Feature ID');
  return path.join(brain, 'features', `${key}.yaml`).replaceAll('\\', '/');
}

export function nextRequirementsVersion(version: string): string {
  const [major, minor, patch] = version.split(/[.+-]/);
  return `${major}.${minor}.${BigInt(patch) + 1n}`;
}

/** The byte limit covers the persisted representation, including expanded aliases. */
export function serializeRequirements(spec: FeatureSpec): string {
  const source = stringify(spec, { aliasDuplicateObjects: false });
  if (Buffer.byteLength(source) > TASK_CLI_INPUT_BYTES)
    throw new SchemaValidationError(['Serialized FeatureSpec exceeds 1 MiB limit']);
  return source;
}

export function writeRequirements(
  cwd: string,
  relative: string,
  spec: FeatureSpec,
  previous?: FeatureSpec,
): void {
  taskDirectory(cwd, path.dirname(relative));
  const file = taskPath(cwd, relative);
  const source = serializeRequirements(spec);
  if (previous) {
    if (JSON.stringify(readRequirements(cwd, relative, spec.key)) !== JSON.stringify(previous))
      throw new Error('Feature revision changed before writing');
    // Existing file has passed path/link/regular-file checks and the containment guard.
    fs.writeFileSync(file, source, { flag: 'r+', mode: 0o600 });
    fs.truncateSync(file, Buffer.byteLength(source));
  } else fs.writeFileSync(file, source, { flag: 'wx', mode: 0o600 });
}

export function requirementsDecisionContext(
  key: string,
  questions: string[],
  version?: string,
): string {
  const content = JSON.stringify(version ? { questions, version } : questions);
  const digest = createHash('sha256').update(content).digest('hex');
  return `feature-requirements/${key}/${digest}\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;
}

/** One existing Task gate covers all product questions; no parallel gates are invented. */
export async function openRequirementsQuestions(
  store: WorkStore,
  key: string,
  questions: string[],
  version?: string,
) {
  if (!questions.length) return;
  const context = requirementsDecisionContext(key, questions, version);
  if (
    store
      .listDecisions()
      .some(
        (d) =>
          d.context === context ||
          (d.context === requirementsDecisionContext(key, questions) && !d.answer?.startsWith('{')),
      )
  )
    return;
  await store.openOrJoinIdleDecision({
    id: randomUUID(),
    context,
    blocks: [key],
    requestedBy: 'requirements-analyst',
    options: [
      {
        id: 'answer',
        label: 'Resolver todas las preguntas',
        benefit: 'Aclara el alcance',
        cost: 'Tiempo del operador',
        risk: 'Revisar el requisito afectado',
      },
    ],
    recommendation: 'Resolver todas las preguntas y documentar las respuestas antes de aprobar',
    disagreement: [],
    impact: 'Bloquea la aprobación del FeatureSpec',
    urgency: 'medium',
  });
}

export function readRequirements(cwd: string, relative: string, key: string): FeatureSpec {
  return validateRequirements(readTaskInput(cwd, relative), key);
}
