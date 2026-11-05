import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';
import { parse } from 'yaml';

import type { ProjectConfig } from '../../core/src/project.js';
import type { ResearchMode, SourceItem } from '../../core/src/research.js';
import { readTaskInput, taskDirectory, taskPath } from './commands/taskFiles.js';
import {
  FEATURE_PLAN_HEADINGS,
  FEATURE_RESEARCH_DIRECTORY,
  FEATURE_RESEARCH_EVIDENCE_LIMIT,
  FEATURE_RESEARCH_EVIDENCE_NOTICE,
  FEATURE_RESEARCH_MAX_ITEMS,
  FEATURE_RESEARCH_STATUSES,
  FEATURE_RESEARCH_TEXT_CHARS,
  RESEARCH_DELIVERY_SOURCE_PATH,
  RESEARCH_NON_DELIVERY_PATH,
  RESEARCH_REPORT_MAX_BYTES,
  ZONES_GIT_TIMEOUT_MS,
} from './constants.js';
import { featureDocument } from './featureArtifacts.js';
import { withoutOperatorToken } from './featureIngress.js';
import { designSection } from './featurePlanProjection.js';
import { readIdeaResearch, type SavedResearch } from './ideaResearch.js';
import { validateSourceItem } from './research.js';
import { compileSchema, validateSchema } from './schemaValidation.js';
import { parseTaskDag } from './taskDag.js';
import { gitCommonDir, openReadOnlyWorkStore } from './workstore/readOnlyWorkStore.js';
import type {
  DesignRecord,
  FeatureRecord,
  FeatureRunState,
  TaskRecord,
} from './workstore/WorkStore.js';

export interface ReviewItem {
  id: string;
  kind: 'acceptance' | 'plan';
  text: string;
}
export interface ReviewEvidence {
  ref: string;
  quote: string;
}
interface DeliveryEvidence {
  quote: string;
  /** Columns containing a recognized code anchor, excluding comments and literal text. */
  tokens: { start: number; end: number }[];
}
export interface FeatureResearchReview {
  coverage: {
    id: string;
    status: (typeof FEATURE_RESEARCH_STATUSES)[number];
    explanation: string;
    evidence: ReviewEvidence[];
  }[];
  proposals: { label: 'proposal'; text: string; evidence: ReviewEvidence[] }[];
}
export interface FeatureResearchInput {
  key: string;
  branch: string;
  base: string;
  head: string;
  sources: ReturnType<typeof featureDocument>['sources'];
  preResearch: SavedResearch | null;
  bibliography: SourceItem[];
  diff: string;
  items: ReviewItem[];
  evidence: ReviewEvidence[];
  /** Runtime-only delivery provenance. Never populated from external IDs or model output. */
  branchEvidence: ReadonlyMap<string, DeliveryEvidence>;
}
export interface SavedFeatureResearch {
  kind: 'feature-research-review';
  provenance: 'untrusted-external';
  id: string;
  feature: string;
  mode: ResearchMode;
  partial: boolean;
  branch: string;
  base: string;
  head: string;
  items: ReviewItem[];
  report: FeatureResearchReview;
  evidenceNotice: string;
  bibliography: SourceItem[];
  gaps: string[];
  cost: SavedResearch['cost'];
}

const text = { type: 'string', minLength: 1, maxLength: FEATURE_RESEARCH_TEXT_CHARS };
const evidenceSchema = {
  type: 'array',
  maxItems: FEATURE_RESEARCH_EVIDENCE_LIMIT,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['ref', 'quote'],
    properties: { ref: text, quote: text },
  },
};
export const FEATURE_RESEARCH_SCHEMA = {
  title: 'FeatureResearchReview',
  type: 'object',
  additionalProperties: false,
  required: ['coverage', 'proposals'],
  properties: {
    coverage: {
      type: 'array',
      maxItems: FEATURE_RESEARCH_MAX_ITEMS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'explanation', 'evidence'],
        properties: {
          id: text,
          status: { enum: FEATURE_RESEARCH_STATUSES },
          explanation: text,
          evidence: evidenceSchema,
        },
      },
    },
    proposals: {
      type: 'array',
      maxItems: FEATURE_RESEARCH_MAX_ITEMS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'text', 'evidence'],
        properties: { label: { const: 'proposal' }, text, evidence: evidenceSchema },
      },
    },
  },
};
const validate = compileSchema<FeatureResearchReview>(FEATURE_RESEARCH_SCHEMA);

/** No Git commands can run diff drivers, textconv, pagers or optional index writes. */
function git(root: string, args: string[]): string {
  try {
    return execFileSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...withoutOperatorToken(process.env), GIT_OPTIONAL_LOCKS: '0' },
      maxBuffer: RESEARCH_REPORT_MAX_BYTES,
      timeout: ZONES_GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('Feature research Git evidence unavailable or exceeds size limit');
  }
}

/** Syntax is a conservative provenance gate, never a semantic proof of delivery. */
function deliveryTokens(file: string, source: string): Map<number, DeliveryEvidence['tokens']> {
  const lines = new Map<number, DeliveryEvidence['tokens']>();
  // Do not treat the parser's recovery nodes for renamed prose as implementation.
  if (
    ts
      .transpileModule(source, {
        fileName: file,
        compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.Preserve },
        reportDiagnostics: true,
      })
      .diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  )
    return lines;
  const root = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const emptyFunction = (node: ts.Node) =>
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
    node.body &&
    ts.isBlock(node.body) &&
    node.body.statements.length === 0;
  const visit = (node: ts.Node): void => {
    // Exclude simple text-only/empty wrappers; this is not a semantic code check.
    if (
      emptyFunction(node) ||
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.every(
          ({ initializer }) =>
            !initializer ||
            ts.isStringLiteral(initializer) ||
            ts.isNoSubstitutionTemplateLiteral(initializer) ||
            emptyFunction(initializer),
        )) ||
      (ts.isCallExpression(node) &&
        /^(it|test|describe)(\.(only|skip|todo))?$/.test(node.expression.getText(root)) &&
        (/\.(skip|todo)$/.test(node.expression.getText(root)) ||
          !node.arguments.some(
            (argument) =>
              (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) &&
              !emptyFunction(argument),
          )))
    )
      return;
    // Bare strings, template/JSX text, identifiers and comments are not code anchors.
    if (
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((declaration) => declaration.initializer)) ||
      (ts.isFunctionDeclaration(node) && node.body) ||
      (ts.isClassDeclaration(node) && node.members.length) ||
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      (ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      (ts.isReturnStatement(node) && node.expression) ||
      ts.isThrowStatement(node)
    ) {
      const token = node.getFirstToken(root);
      if (
        token &&
        (token.kind === ts.SyntaxKind.Identifier ||
          (token.kind >= ts.SyntaxKind.FirstKeyword && token.kind <= ts.SyntaxKind.LastKeyword))
      ) {
        const { line, character } = root.getLineAndCharacterOfPosition(token.getStart(root));
        const tokens = lines.get(line + 1) ?? [];
        tokens.push({ start: character, end: character + token.getWidth(root) });
        lines.set(line + 1, tokens);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return lines;
}

/** Only SELECTs on the existing store: no migrations, leases, recovery or status writes. */
export function featureResearchInput(config: ProjectConfig, key: string): FeatureResearchInput {
  const db = openReadOnlyWorkStore(config.repoRoot);
  try {
    db.exec('BEGIN');
    const feature = db
      .prepare('SELECT * FROM features WHERE project_id = ? AND key = ?')
      .get(config.project.id, key) as FeatureRecord | undefined;
    if (!feature) throw new Error('Unknown Feature');
    const row = db
      .prepare('SELECT state FROM feature_runs WHERE project_id = ? AND feature_key = ?')
      .get(config.project.id, key) as { state: string } | undefined;
    const state: FeatureRunState | undefined = row ? JSON.parse(row.state) : undefined;
    if (
      !state ||
      state.status !== 'ready_to_merge' ||
      state.branch !== `sa/${key}-integration` ||
      !Object.keys(state.integrated).length
    )
      throw new Error(
        'Feature has no built branch; finish the Feature build before research review',
      );
    const ref = `refs/heads/${state.branch}`;
    let branchHead: string;
    try {
      branchHead = git(config.repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
    } catch {
      throw new Error('Feature has no built branch; the recorded built branch is missing');
    }
    if (
      !/^[a-f0-9]{40,64}$/.test(state.head) ||
      !/^[a-f0-9]{40,64}$/.test(state.initial_main) ||
      branchHead !== state.head
    )
      throw new Error('Feature built branch is missing or changed; research review refused');
    const task = db
      .prepare('SELECT * FROM tasks WHERE project_id = ? AND key = ?')
      .get(config.project.id, key) as TaskRecord | undefined;
    const design = db
      .prepare('SELECT * FROM technical_designs WHERE project_id = ? AND feature_key = ?')
      .get(config.project.id, key) as DesignRecord | undefined;
    const { spec, sources } = featureDocument(
      { getTask: () => task, getDesign: () => design },
      config,
      feature,
    );
    if (!sources.design || !sources.dag) throw new Error('Feature has no built design or DAG');
    // A built branch may not silently replace the promises that this review compares.
    for (const [relative, content] of [
      [feature.doc_path, sources.requirements],
      [design!.doc_path, sources.design],
      [design!.dag_path, sources.dag],
    ])
      if (git(config.repoRoot, ['show', `${state.head}:${relative}`]) !== content)
        throw new Error('Built branch plan differs from the bound Feature plan');
    const dag = parseTaskDag(parse(sources.dag));
    const items: ReviewItem[] = [
      ...spec.acceptance.map((ac) => ({
        id: ac.id,
        kind: 'acceptance' as const,
        text: JSON.stringify(ac),
      })),
      { id: 'design:architecture', kind: 'plan', text: sources.design },
      ...Object.entries(FEATURE_PLAN_HEADINGS).flatMap(([name, heading]) => {
        const section = designSection(sources.design, heading);
        return section ? [{ id: `design:${name}`, kind: 'plan' as const, text: section }] : [];
      }),
      ...dag.tasks.map((task) => ({
        id: task.key,
        kind: 'plan' as const,
        text: JSON.stringify(task),
      })),
    ];
    if (
      dag.feature !== key ||
      items.length > FEATURE_RESEARCH_MAX_ITEMS ||
      new Set(items.map((item) => item.id)).size !== items.length
    )
      throw new Error('Invalid or oversized Feature research plan');
    const diffOptions = [
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
    ];
    const revisions = [state.initial_main, state.head];
    // Bind each patch to an exact NUL-delimited name and a literal pathspec. Never
    // parse +++ filenames: tabs and C quoting there are presentation, not path data.
    const files = git(config.repoRoot, [
      'diff',
      ...diffOptions,
      '--name-only',
      '-z',
      ...revisions,
      '--',
    ])
      .split('\0')
      .filter(Boolean);
    const patches: string[] = [];
    let diffBytes = 0;
    // References have disjoint runtime-owned namespaces; external IDs remain metadata only.
    const evidenceByRef = new Map<string, string>();
    const branchEvidence = new Map<string, DeliveryEvidence>();
    const promises = new Set([feature.doc_path, design!.doc_path, design!.dag_path]);
    for (const file of files) {
      const patch = git(config.repoRoot, [
        'diff',
        ...diffOptions,
        ...revisions,
        '--',
        `:(literal)${file}`,
      ]);
      diffBytes += Buffer.byteLength(patch);
      if (diffBytes > RESEARCH_REPORT_MAX_BYTES)
        throw new Error('Feature research Git evidence exceeds size limit');
      patches.push(patch);
      let line = 0,
        oldRemaining = 0,
        newRemaining = 0;
      let tokens = new Map<number, DeliveryEvidence['tokens']>();
      for (const entry of patch.split('\n')) {
        if (entry.startsWith('diff --git ')) {
          tokens = new Map();
          line = 0;
          oldRemaining = newRemaining = 0;
        } else if (oldRemaining || newRemaining) {
          // Inside a hunk, even "+++ b/path" is literal file content, not a header.
          if (entry.startsWith(' ') || entry.startsWith('+')) {
            if (newRemaining > 0) {
              const ref = `branch:${file}:${line}`,
                quote = entry.slice(1);
              evidenceByRef.set(ref, quote);
              if (entry.startsWith('+') && tokens.has(line))
                branchEvidence.set(ref, { quote, tokens: tokens.get(line)! });
            }
            line++;
            newRemaining--;
          }
          if (entry.startsWith(' ') || entry.startsWith('-')) oldRemaining--;
        } else if (entry.startsWith('+++ ') && entry !== '+++ /dev/null') {
          if (
            !promises.has(file) &&
            !RESEARCH_NON_DELIVERY_PATH.test(file) &&
            RESEARCH_DELIVERY_SOURCE_PATH.test(file) &&
            !/\.d\.[cm]?ts$/i.test(file)
          )
            tokens = deliveryTokens(file, git(config.repoRoot, ['show', `${state.head}:${file}`]));
        } else {
          const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(entry);
          if (hunk) {
            oldRemaining = Number(hunk[1] ?? 1);
            line = Number(hunk[2]);
            newRemaining = Number(hunk[3] ?? 1);
          }
        }
      }
    }
    const diff = patches.join('');
    let preResearch: SavedResearch | null = null;
    if (fs.existsSync(taskPath(config.repoRoot, state.request))) {
      const request = readTaskInput(config.repoRoot, state.request);
      const previous = readIdeaResearch(config.repoRoot, state.request, request);
      if (previous)
        preResearch = JSON.parse(
          readTaskInput(config.repoRoot, previous.path, RESEARCH_REPORT_MAX_BYTES),
        );
    }
    const bibliography = preResearch?.report.bibliography.map(validateSourceItem) ?? [];
    bibliography.forEach((source, index) => evidenceByRef.set(`external:${index}`, source.excerpt));
    const evidence = [...evidenceByRef].map(([ref, quote]) => ({ ref, quote }));
    db.exec('COMMIT');
    return {
      key,
      branch: state.branch,
      base: state.initial_main,
      head: state.head,
      sources,
      preResearch,
      bibliography,
      diff,
      items,
      evidence,
      branchEvidence,
    };
  } finally {
    db.close();
  }
}

/** Missing rows and fabricated/absent citations cannot qualify as cited code. */
export function validateFeatureResearch(
  output: string,
  input: FeatureResearchInput,
): FeatureResearchReview {
  try {
    if (Buffer.byteLength(output) > RESEARCH_REPORT_MAX_BYTES) throw new Error();
    const report = validateSchema(validate, JSON.parse(output));
    const ids = new Set(input.items.map((item) => item.id));
    if (
      new Set(report.coverage.map((row) => row.id)).size !== report.coverage.length ||
      report.coverage.some((row) => !ids.has(row.id))
    )
      throw new Error();
    const validEvidence = (entries: ReviewEvidence[]) =>
      entries.filter(
        (entry) =>
          entry.quote.trim() &&
          input.evidence.some(
            (source) => source.ref === entry.ref && source.quote.includes(entry.quote),
          ),
      );
    return {
      coverage: input.items.map((item) => {
        const row = report.coverage.find((row) => row.id === item.id);
        const evidence = validEvidence(row?.evidence ?? []);
        // A citation belongs to this row only; it never supplies evidence for other items.
        const deliveryEvidence = evidence.some((entry) => {
          const source = input.branchEvidence.get(entry.ref);
          if (!source) return false;
          // A substring of a comment or test title on a code line is still prose.
          for (
            let start = source.quote.indexOf(entry.quote);
            start >= 0;
            start = source.quote.indexOf(entry.quote, start + 1)
          )
            if (
              source.tokens.some(
                (token) => token.start >= start && token.end <= start + entry.quote.length,
              )
            )
              return true;
          return false;
        });
        if (!row || !evidence.length || (row.status !== 'not verifiable' && !deliveryEvidence))
          return {
            id: item.id,
            status: 'not verifiable',
            explanation: 'No qualifying code citation supplied.',
            evidence: [],
          };
        return { ...row, evidence };
      }),
      proposals: report.proposals.map((proposal) => ({
        ...proposal,
        evidence: validEvidence(proposal.evidence),
      })),
    };
  } catch {
    throw new Error('Feature research output failed schema validation');
  }
}

export function emptyFeatureResearch(input: FeatureResearchInput): FeatureResearchReview {
  return {
    coverage: input.items.map((item) => ({
      id: item.id,
      status: 'not verifiable',
      explanation: 'No validated evidence produced.',
      evidence: [],
    })),
    proposals: [],
  };
}

export function featureResearchDirectory(config: ProjectConfig, key: string): string {
  if (!/^[\w-]+$/.test(config.project.id) || !/^FEAT-\d{3}$/.test(key))
    throw new Error('Invalid Feature identity');
  return taskDirectory(
    gitCommonDir(config.repoRoot),
    `${FEATURE_RESEARCH_DIRECTORY}/${config.project.id}/${key}`,
  );
}

/** Indent all model/source content so Markdown/HTML/links remain literal text. */
export function featureResearchMarkdown(result: SavedFeatureResearch): string {
  const literal = (value: string) =>
    value
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
  return [
    '# Feature research review',
    '```json\n{"kind":"feature-research-review","provenance":"untrusted-external"}\n```',
    `Feature ${result.feature}. Mode ${result.mode}. Status ${result.partial ? 'partial' : 'complete'}.`,
    `Branch ${result.branch}. Base ${result.base}. Head ${result.head}.`,
    'Untrusted comparison. Proposals require human review and create no tasks.',
    FEATURE_RESEARCH_EVIDENCE_NOTICE,
    '## Coverage',
    ...result.report.coverage.map((row) =>
      literal(
        `${row.id}: ${row.status === 'code_cited' ? 'Código citado: requiere verificación' : row.status}\n${row.explanation}\n${row.evidence.map((e) => `${e.ref}: ${e.quote}`).join('\n')}`,
      ),
    ),
    '## Improvement proposals',
    ...result.report.proposals.map((proposal) =>
      literal(
        `proposal: ${proposal.text}\n${proposal.evidence.map((e) => `${e.ref}: ${e.quote}`).join('\n')}`,
      ),
    ),
    '## Gaps',
    ...result.gaps.map(literal),
    '## Sources',
    ...result.bibliography.map((s) =>
      literal(`${s.id}\n${s.title}\n${s.url ?? s.citation}\nRetrieved ${s.retrievedAt}`),
    ),
    '## Coste',
    result.cost.label,
    `Estimación ${result.cost.estimateUsd} USD. Tope ${result.cost.capUsd} USD. Gasto contabilizado ${result.cost.usedEstimateUsd} USD.`,
    ...(result.cost.stopReason ? [result.cost.stopReason] : []),
    '',
  ].join('\n\n');
}

export function writeFeatureResearch(directory: string, result: SavedFeatureResearch): string {
  const files = [
    ['md', featureResearchMarkdown(result)],
    ['json', JSON.stringify(result, null, 2)],
  ];
  for (const [, content] of files)
    if (Buffer.byteLength(content) > RESEARCH_REPORT_MAX_BYTES)
      throw new Error('Feature research report exceeds size limit');
  for (const [suffix, content] of files) {
    fs.writeFileSync(taskPath(directory, `${result.id}.${suffix}`), content, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  return path.join(directory, `${result.id}.md`);
}
