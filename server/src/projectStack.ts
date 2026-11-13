import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { HumanDecision } from '../../core/src/humanDecision.js';
import type { ProjectConfig } from '../../core/src/project.js';
import type {
  ProjectStackDecision,
  StackClaim,
  StackProposal,
} from '../../core/src/projectStack.js';
import type { SourceItem } from '../../core/src/research.js';
import { reserveAdrPaths } from './adrPaths.js';
import { readTaskInput, taskDirectory, taskPath } from './commands/taskFiles.js';
import {
  STACK_ADR_LOCK_LEASE_MS,
  STACK_ADR_LOCK_TIMEOUT_MS,
  STACK_COMPONENTS,
  STACK_CRITERIA,
} from './constants.js';
import { validateExternalReaderResult } from './externalContent.js';
import { withLeaseLock } from './leaseLock.js';
import { handoffText } from './research.js';
import { validateStackProposal } from './techLead.js';
import type { WorkStore } from './workstore/WorkStore.js';

type Decisions = Pick<WorkStore, 'listDecisions' | 'getFeature'>;

/** Proposed Brain artifacts stay on the already bound Requirements branch. */
export function stackArtifactRoot(
  store: Pick<WorkStore, 'getTask'>,
  config: ProjectConfig,
  key: string,
): string {
  const expected = taskPath(config.repoRoot, `.worktrees/${key}`);
  if (store.getTask(key)?.worktree_ref !== expected)
    throw new Error('Stack requires the bound Feature worktree');
  return expected;
}

export function stackDecision(store: Decisions, key: string): HumanDecision | undefined {
  const feature = store.getFeature(key);
  return store
    .listDecisions()
    .find(
      (decision) =>
        decision.projectStack?.feature === key &&
        decision.projectStack.specSha === feature?.git_sha,
    );
}

function chosenStack(decision: HumanDecision) {
  if (decision.status !== 'answered' || !decision.answeredBy || !decision.answeredAt)
    return undefined;
  return decision.projectStack?.proposal.alternatives.find(
    (option) => option.id === decision.answer,
  );
}

const literal = (value: string) =>
  value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
const claimText = (claim: StackClaim) =>
  literal(`${claim.text}${claim.sources.length ? `\nSources ${claim.sources.join(', ')}` : ''}`);

/** ADR is a deterministic projection of the durable human decision, including recovery. */
export function stackAdr(decision: HumanDecision): string {
  const binding = decision.projectStack;
  if (!binding) throw new Error('Missing stack decision binding');
  const chosen = chosenStack(decision);
  const proposal = binding.proposal;
  return [
    '# Stack tecnológico del proyecto',
    '```json\n{"kind":"project-stack-adr","provenance":"untrusted-external"}\n```',
    `Estado · ${chosen ? 'Aceptado' : 'Propuesto'}`,
    `Feature · ${binding.feature}\n\nRequisitos · ${binding.specSha}\n\nDecisión · ${decision.id}`,
    'Compatibilidad requerida · Arquitectura hexagonal por defecto (SA-158).',
    ...(chosen
      ? [
          '## Opción elegida',
          literal(chosen.name),
          '## Motivo de la opción elegida',
          claimText(chosen.comparison.fit),
          '## Riesgos aceptados',
          claimText(chosen.comparison.risks),
        ]
      : []),
    '## Alternativas',
    ...proposal.alternatives.flatMap((alternative) => [
      `### ${alternative.name}`,
      ...Object.entries(STACK_COMPONENTS).flatMap(([key, label]) => {
        // SAFETY: catalog keys match the closed stack component record.
        return [
          `#### ${label}`,
          claimText(alternative.stack[key as keyof typeof STACK_COMPONENTS]),
        ];
      }),
      ...Object.entries(STACK_CRITERIA).flatMap(([key, label]) => {
        // SAFETY: catalog keys match the closed comparison record.
        return [
          `#### ${label}`,
          claimText(alternative.comparison[key as keyof typeof STACK_CRITERIA]),
        ];
      }),
      '#### Compatibilidad hexagonal',
      claimText(alternative.hexagonal),
    ]),
    '## Recomendación del Tech Lead',
    literal(proposal.alternatives.find((option) => option.id === proposal.recommendation)!.name),
    claimText(proposal.why),
    '## Qué se pierde frente a las otras alternativas',
    ...proposal.losses.map(
      (loss) =>
        literal(proposal.alternatives.find((option) => option.id === loss.alternative)!.name) +
        '\n\n' +
        claimText(loss.detail),
    ),
    '## Fuentes',
    ...binding.bibliography.map((source) =>
      literal(
        `${source.id}\n${source.title}\n${source.url ?? source.citation}\nRetrieved ${source.retrievedAt}`,
      ),
    ),
    '',
  ].join('\n\n');
}

export function materializeStackAdr(
  config: ProjectConfig,
  decision: HumanDecision,
  store: Pick<WorkStore, 'getTask' | 'listDecisions'>,
): void {
  if (!decision.projectStack) return;
  withLeaseLock(
    {
      dir: path.join(os.homedir(), '.pixel-agents', 'locks', 'project-stack', config.project.id),
      name: `${decision.projectStack.feature}.lock`,
      timeoutMs: STACK_ADR_LOCK_TIMEOUT_MS,
      leaseMs: STACK_ADR_LOCK_LEASE_MS,
      label: 'Stack ADR projection',
    },
    () => {
      const current = store.listDecisions().find((entry) => entry.id === decision.id);
      if (!current?.projectStack) throw new Error('Stack decision binding changed');
      writeStackAdr(config, current, store);
    },
  );
}

function writeStackAdr(
  config: ProjectConfig,
  decision: HumanDecision,
  store: Pick<WorkStore, 'getTask'>,
): void {
  const binding = decision.projectStack;
  if (!binding) return;
  const root = stackArtifactRoot(store, config, binding.feature);
  const adrDirectory = path.posix.join(config.project.brain.path.replaceAll('\\', '/'), 'adr');
  if (
    path.posix.dirname(binding.adrPath) !== adrDirectory ||
    !/^\d{4}-stack-tecnologico\.md$/.test(path.posix.basename(binding.adrPath))
  )
    throw new Error('Stack ADR path binding changed');
  taskDirectory(root, adrDirectory);
  const file = taskPath(root, binding.adrPath);
  const content = stackAdr(decision);
  if (fs.existsSync(file)) {
    const current = readTaskInput(root, binding.adrPath);
    if (current === content) return;
    // Only the proposed projection for this exact decision may become accepted.
    if (current !== stackAdr({ ...decision, status: 'open', answer: null }))
      throw new Error('Stack ADR changed outside the decision workflow');
  }
  const staging = `${binding.adrPath}.${randomUUID()}.tmp`;
  const temporary = taskPath(root, staging);
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    taskPath(root, binding.adrPath);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export async function proposeProjectStack(
  store: WorkStore,
  config: ProjectConfig,
  key: string,
  proposal: StackProposal,
  bibliography: SourceItem[],
): Promise<HumanDecision> {
  const existing = stackDecision(store, key);
  if (existing) {
    materializeStackAdr(config, existing, store);
    return existing;
  }
  const feature = store.getFeature(key);
  if (feature?.status !== 'approved') throw new Error('Stack requires approved requirements');
  const checked = validateStackProposal(JSON.stringify(proposal), bibliography);
  if (!store.getTask(`${key}-DESIGN`))
    store.createTask({
      key: `${key}-DESIGN`,
      type: 'architecture',
      agent_role: 'architect',
      status: 'DRAFT',
    });
  const [adrPath] = await reserveAdrPaths(
    stackArtifactRoot(store, config, key),
    config.project.brain.path,
    key,
    ['stack tecnologico'],
    store,
    'stack',
  );
  const binding: ProjectStackDecision = {
    feature: key,
    specSha: feature.git_sha,
    adrPath,
    proposal: checked,
    bibliography,
  };
  const { decision } = await store.openOrJoinIdleDecision({
    id: randomUUID(),
    context: `project-stack/${key}/${feature.git_sha}\nElegir el stack del proyecto`,
    requestedBy: 'tech-lead',
    blocks: [`${key}-DESIGN`],
    options: checked.alternatives.map((option) => ({
      id: option.id,
      label: option.name,
      benefit: option.comparison.fit.text,
      cost: option.comparison.cost.text,
      risk: option.comparison.risks.text,
    })),
    recommendation: `${checked.alternatives.find((option) => option.id === checked.recommendation)!.name} · ${checked.why.text}`,
    disagreement: [],
    impact: 'El diseño y el plan esperan tu elección del stack.',
    urgency: 'medium',
    projectStack: binding,
  });
  materializeStackAdr(config, decision, store);
  return decision;
}

/** Canonical architecture policy. An agent recommendation never satisfies this gate. */
export function requireProjectStack(store: Decisions, key: string): string {
  const decision = stackDecision(store, key);
  const chosen = decision && chosenStack(decision);
  if (!decision || !chosen)
    throw new Error('El diseño espera la decisión humana sobre el stack del proyecto.');
  return JSON.stringify(
    validateExternalReaderResult({
      kind: 'external-reader-result',
      facts: [
        `Stack elegido · ${chosen.name}`,
        ...Object.entries(STACK_COMPONENTS).map(
          ([key, label]) =>
            // SAFETY: catalog keys enumerate the closed stack component record.
            `${label} · ${chosen.stack[key as keyof typeof STACK_COMPONENTS].text}`,
        ),
        `Motivo · ${chosen.comparison.fit.text}`,
        `Riesgos · ${chosen.comparison.risks.text}`,
        `Compatibilidad hexagonal · ${chosen.hexagonal.text}`,
      ].map((text) => ({ text: handoffText(text), confidence: 'low' })),
      insufficientEvidence: Object.values(chosen.stack).some((claim) => !claim.sources.length),
    }),
  );
}
