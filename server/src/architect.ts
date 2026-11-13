import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { stringify } from 'yaml';

import * as dagContract from '../../core/schemas/task-dag.schema.json';
import type { FeatureSpec } from '../../core/src/featureSpec.js';
import type { TaskDag } from '../../core/src/taskDag.js';
import { reserveAdrPaths } from './adrPaths.js';
import {
  type ArchitectureChoice,
  architectureChoiceContract,
  openArchitectureAlternative,
  requireArchitectureChoice,
} from './architectureDecisions.js';
import { validateChangeZone } from './changeZones.js';
import { readTaskInput, taskDirectory, taskPath } from './commands/taskFiles.js';
import { TASK_CLI_INPUT_BYTES } from './constants.js';
import { ARCHITECTURE_PROPOSAL_ERROR, HEXAGONAL_TEMPLATE } from './projectArchitectureConstants.js';
import { stackAdr, stackDecision } from './projectStack.js';
import { compileSchema, SchemaValidationError, validateSchema } from './schemaValidation.js';
import { analyzeTaskDag, parseTaskDag, parseTechnicalDesign } from './taskDag.js';
import type { WorkStore } from './workstore/WorkStore.js';

export interface ArchitectRequest {
  key: string;
  spec: FeatureSpec;
  gitSha: string;
  revision?: { gitSha: string; decisionId: string; answers: string };
}

export interface ArchitectProposal {
  architecture?: ArchitectureChoice;
  components: string[];
  risks: string[];
  body: string;
  dag: TaskDag;
  adrs?: { title: string; body: string }[];
}

const text = { type: 'string', minLength: 1, pattern: '\\S' };
export const architectContract = {
  type: 'object',
  additionalProperties: false,
  required: ['components', 'risks', 'body', 'dag'],
  properties: {
    architecture: architectureChoiceContract,
    components: { type: 'array', minItems: 1, uniqueItems: true, items: text },
    risks: { type: 'array', uniqueItems: true, items: text },
    body: text,
    dag: { type: 'object' },
    adrs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'body'],
        properties: { title: text, body: text },
      },
    },
  },
};
const validateProposal = compileSchema<ArchitectProposal>(architectContract);

export function architectTaskKey(key: string): string {
  if (!/^FEAT-\d{3}$/.test(key)) throw new Error('Invalid Feature ID');
  return `${key}-DESIGN`;
}

export function architectPaths(brain: string, key: string) {
  architectTaskKey(key);
  const doc = path.posix.join(brain.replaceAll('\\', '/'), 'technical-designs', key);
  return { doc: `${doc}.md`, dag: `${doc}.dag.yaml` };
}

/** Missing context is explicit. All reads use the same link/size guards as Requirements. */
export function architectContext(cwd: string, brain: string): Record<string, string | null> {
  return Object.fromEntries(
    ['ARCHITECTURE.md', 'VISION.md', 'RULES.md', 'CONSTRAINTS.md'].map((name) => {
      const relative = path.join(brain, name);
      const file = taskPath(cwd, relative);
      return [name, fs.existsSync(file) ? readTaskInput(cwd, relative) : null];
    }),
  );
}

export function architectBrief(
  input: ArchitectRequest,
  context: Record<string, string | null>,
  errors: string[] = [],
): string {
  return JSON.stringify({
    featureKey: input.key,
    approvedSpec: input.spec,
    approvedGitSha: input.gitSha,
    context,
    answers: input.revision?.answers ?? null,
    contract: architectContract,
    dagContract,
    architectureTemplate: HEXAGONAL_TEMPLATE,
    testScope:
      'Declare additional test roots in optional testZones; otherwise only changeZones, colocated tests and the server/src -> server/__tests__ mirror are allowed.',
    validationErrors: errors,
  });
}

export function validateArchitect(
  source: string,
  spec: FeatureSpec,
  checkout: { cwd: string; protectedPaths?: readonly string[] },
): ArchitectProposal {
  if (Buffer.byteLength(source) > TASK_CLI_INPUT_BYTES)
    throw new SchemaValidationError(['Architect proposal exceeds 1 MiB limit']);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new SchemaValidationError(['Architect must return a JSON object']);
  }
  const proposal = validateSchema(validateProposal, value);
  if (
    proposal.architecture?.kind === 'alternative' &&
    !proposal.architecture.alternatives.some((alternative) => /hexagonal/i.test(alternative))
  )
    throw new SchemaValidationError([
      'Compara la propuesta con la arquitectura hexagonal en alternatives.',
    ]);
  const dag = parseTaskDag(proposal.dag);
  const errors = analyzeTaskDag(dag, spec).issues.map((issue) => JSON.stringify(issue));
  dag.tasks.forEach((task) => {
    if (
      proposal.architecture?.kind === 'hexagonal' &&
      !/\b(domain|application|adapters\/(in|out)|composition)\b/.test(task.title)
    )
      errors.push(`${task.key}: el título debe nombrar la capa hexagonal`);
    if (!task.changeZones?.length) errors.push(`${task.key}: changeZones required`);
    if (typeof task.parallelizable !== 'boolean')
      errors.push(`${task.key}: parallelizable required`);
    for (const zone of [...(task.changeZones ?? []), ...(task.testZones ?? [])]) {
      try {
        validateChangeZone(checkout.cwd, zone, checkout.protectedPaths ?? []);
      } catch (error) {
        errors.push(`${task.key}: changeZones/testZones ${zone}: ${(error as Error).message}`);
      }
    }
  });
  if (errors.length) throw new SchemaValidationError(errors);
  return proposal;
}

/** The model supplies content only. Paths, metadata and ADR numbers belong to the runtime. */
export async function architectArtifacts(
  cwd: string,
  brain: string,
  key: string,
  proposal: ArchitectProposal,
  store: WorkStore,
): Promise<Map<string, string>> {
  const paths = architectPaths(brain, key);
  const alternative =
    proposal.architecture?.kind === 'alternative' ? proposal.architecture : undefined;
  const adrPaths = await reserveAdrPaths(
    cwd,
    brain,
    key,
    [
      ...(alternative ? ['arquitectura del proyecto'] : []),
      ...(proposal.adrs ?? []).map((adr) => adr.title),
    ],
    store,
  );
  const files = new Map<string, string>();
  const adrs: string[] = [];
  if (alternative) {
    files.set(adrPaths[0], requireArchitectureChoice(store, key, alternative, adrPaths[0]));
    adrs.push(`ADR-${path.basename(adrPaths[0]).slice(0, 4)}`);
  }
  for (const [index, adr] of (proposal.adrs ?? []).entries()) {
    const relative = adrPaths[index + (alternative ? 1 : 0)];
    const id = path.basename(relative).slice(0, 4);
    files.set(relative, `# ADR-${id}: ${adr.title}\n\n${adr.body}\n`);
    adrs.push(`ADR-${id}`);
  }
  const stack = stackDecision(store, key);
  if (stack?.status === 'answered' && stack.projectStack) {
    files.set(stack.projectStack.adrPath, stackAdr(stack));
    adrs.push(`ADR-${path.basename(stack.projectStack.adrPath).slice(0, 4)}`);
  }
  const metadata = parseTechnicalDesign({
    apiVersion: 'softwareagents.io/v1alpha1',
    kind: 'TechnicalDesign',
    feature: key,
    version: '1.0.0',
    status: 'proposed',
    components: proposal.components,
    risks: proposal.risks,
    adrs,
  });
  files.set(
    paths.doc,
    `---\n${stringify(metadata, { aliasDuplicateObjects: false })}---\n\n${proposal.body}\n`,
  );
  files.set(paths.dag, stringify(proposal.dag, { aliasDuplicateObjects: false }));
  for (const [relative, content] of files) {
    if (Buffer.byteLength(content) > TASK_CLI_INPUT_BYTES)
      throw new SchemaValidationError(['Serialized Architect artifact exceeds 1 MiB limit']);
    if (
      fs.existsSync(taskPath(cwd, relative)) &&
      !(relative === stack?.projectStack?.adrPath && readTaskInput(cwd, relative) === content)
    )
      throw new Error('Unregistered Architect artifact already exists');
  }
  return files;
}

export function writeArchitectArtifacts(cwd: string, files: Map<string, string>): void {
  for (const [relative, content] of files) {
    if (fs.existsSync(taskPath(cwd, relative)) && readTaskInput(cwd, relative) === content)
      continue;
    taskDirectory(cwd, path.dirname(relative));
    fs.writeFileSync(taskPath(cwd, relative), content, { flag: 'wx', mode: 0o600 });
  }
}

export async function openArchitectDecision(store: WorkStore, key: string, errors: string[]) {
  const architecture = errors.find((error) => error.startsWith(ARCHITECTURE_PROPOSAL_ERROR));
  if (architecture) return openArchitectureAlternative(store, key, architecture);
  const pending = store
    .listDecisions()
    .find(
      (d) =>
        d.status !== 'answered' && d.context.startsWith(`feature-design/${architectTaskKey(key)}/`),
    );
  if (pending) return;
  return store.openOrJoinIdleDecision({
    id: randomUUID(),
    context: `feature-design/${architectTaskKey(key)}/validation\n${errors.join('\n')}`,
    blocks: [architectTaskKey(key)],
    requestedBy: 'architect',
    options: [
      {
        id: 'answer',
        label: 'Aclarar el diseño',
        benefit: 'Desbloquea el diseño',
        cost: 'Tiempo del operador',
        risk: 'Revisar el DAG',
      },
    ],
    recommendation: 'Documentar respuestas y relanzar feature design --answers',
    disagreement: [],
    impact: 'Bloquea TechnicalDesign y TaskDAG',
    urgency: 'medium',
  });
}
