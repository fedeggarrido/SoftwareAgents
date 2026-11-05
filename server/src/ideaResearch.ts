import * as fs from 'fs';
import * as path from 'path';

import type { ResearchMode, ResearchReport, SourceItem } from '../../core/src/research.js';
import { readTaskInput, taskPath } from './commands/taskFiles.js';
import {
  FEATURE_IDEAS_DIRECTORY,
  RESEARCH_MARKDOWN_SUFFIX,
  RESEARCH_REPORT_MAX_BYTES,
  RESEARCH_REPORT_SUFFIX,
  RESEARCH_TOPICS,
} from './constants.js';
import { containsExternalContent, type ExternalReaderResult } from './externalContent.js';
import {
  researchHandoff,
  sourceHash,
  validateResearchReport,
  validateSourceItem,
} from './research.js';

export interface SavedResearch {
  kind: 'idea-research-report';
  provenance: 'untrusted-external';
  id: string;
  mode: ResearchMode;
  partial: boolean;
  ideaHash?: string;
  report: ResearchReport;
  cost: {
    estimateUsd: number;
    capUsd: number;
    usedEstimateUsd: number;
    label: string;
    stopReason?: string;
  };
}

export function ideaResearchPath(projectId: string, key: string): string {
  if (!/^[\w-]+$/.test(projectId) || !/^FEAT-\d{3}$/.test(key))
    throw new Error('Invalid idea identity');
  return `${FEATURE_IDEAS_DIRECTORY}/${projectId}/${key}.md`;
}

/** Every external line is literal Markdown, including malicious fences/headings. */
const literal = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');

export function researchMarkdown(result: SavedResearch): string {
  const report = result.report;
  return [
    '# Research',
    '```json\n{"kind":"idea-research-report","provenance":"untrusted-external"}\n```',
    `Mode ${result.mode}. Status ${result.partial ? 'partial' : 'complete'}.`,
    'Untrusted external evidence. Claims require verification against their cited sources.',
    `## Coverage\n\n${literal(report.summary)}`,
    ...[...RESEARCH_TOPICS, 'other'].flatMap((topic) => [
      `## ${topic}`,
      ...report.findings
        .filter((finding) => (finding.topic ?? 'other') === topic)
        .map(
          (finding) =>
            `${literal(finding.claim)}\n\n${literal(`${finding.type}, confidence ${finding.confidence}. ${finding.reason}`)}\n\n${literal(`Sources ${finding.sources.join(', ')}`)}`,
        ),
    ]),
    '## Contradictions',
    ...report.contradictions.map((entry) =>
      literal(`${entry.claim}\nSources ${entry.sources.join(', ')}`),
    ),
    `## Gaps and unverifiable claims\n\n${report.gaps.map(literal).join('\n\n') || 'None recorded.'}`,
    '## Sources',
    ...report.bibliography.map((source) =>
      literal(
        `${source.id}\n${source.title}\n${source.url ?? source.citation}\nRetrieved ${source.retrievedAt}`,
      ),
    ),
    `## Coste\n\n${result.cost.label}\n\nEstimación ${result.cost.estimateUsd} USD. Tope ${result.cost.capUsd} USD. Gasto contabilizado ${result.cost.usedEstimateUsd} USD.${result.cost.stopReason ? `\n\nMotivo de parada: ${result.cost.stopReason}` : ''}`,
    '',
  ].join('\n\n');
}

export function reportHandoff(report: ResearchReport): ExternalReaderResult {
  const result = researchHandoff(
    JSON.stringify({
      summary: 'Bounded findings for downstream use.',
      findings: report.findings,
      contradictions: [],
      gaps: [],
      discardedSources: [],
      bibliography: [],
    }),
    report.bibliography,
  );
  result.insufficientEvidence ||= report.gaps.length > 0;
  return result;
}

/** Reports and bounded handoffs can never become the human request or an answer file. */
export function readHumanFeatureInput(root: string, relative: string): string {
  const text = readTaskInput(root, relative);
  if (
    /\.(?:research\.(?:md|json)|handoff\.json)$/.test(relative) ||
    containsExternalContent(text, { rejectHandoffs: true })
  )
    throw new Error('Research evidence cannot be used as a human request or answers');
  return text;
}

export function readIdeaResearch(
  root: string,
  requestPath: string,
  request: string,
): { path: string; result: ExternalReaderResult } | undefined {
  const relative = requestPath.replace(/\.md$/, RESEARCH_REPORT_SUFFIX);
  if (relative === requestPath || !fs.existsSync(taskPath(root, relative))) return undefined;
  try {
    const saved: SavedResearch = JSON.parse(
      readTaskInput(root, relative, RESEARCH_REPORT_MAX_BYTES),
    );
    if (
      !saved ||
      saved.kind !== 'idea-research-report' ||
      saved.provenance !== 'untrusted-external' ||
      saved.ideaHash !== sourceHash(request) ||
      typeof saved.partial !== 'boolean' ||
      !saved.report ||
      !Array.isArray(saved.report.bibliography)
    )
      throw new Error('Invalid research report');
    const sources: SourceItem[] = saved.report.bibliography.map(validateSourceItem);
    const report = validateResearchReport(
      JSON.stringify({ ...saved.report, discardedSources: [], bibliography: [] }),
      sources,
    );
    const result = reportHandoff(report);
    result.insufficientEvidence ||= saved.partial;
    return { path: relative, result };
  } catch {
    // Parser and validator diagnostics may contain arbitrary report content.
    throw new Error('Research report is invalid or does not match the idea draft');
  }
}

/** JSON is the authoritative plan input and is published last by atomic rename. */
export function writeIdeaResearch(root: string, ideaPath: string, result: SavedResearch): void {
  if (sourceHash(readTaskInput(root, ideaPath)) !== result.ideaHash)
    throw new Error('Idea changed during research. The historical report was retained.');
  if (Buffer.byteLength(JSON.stringify(result, null, 2)) > RESEARCH_REPORT_MAX_BYTES)
    throw new Error('Research report exceeds its size limit');
  for (const [suffix, text] of [
    [RESEARCH_MARKDOWN_SUFFIX, researchMarkdown(result)],
    [RESEARCH_REPORT_SUFFIX, JSON.stringify(result, null, 2)],
  ]) {
    const relative = ideaPath.replace(/\.md$/, suffix);
    const destination = taskPath(root, relative);
    if (fs.existsSync(destination)) {
      const stat = fs.lstatSync(destination);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe research storage');
    }
    const staging = `${relative}.${result.id}.stage`;
    const file = taskPath(root, staging);
    try {
      fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
      fs.renameSync(file, taskPath(root, relative));
    } finally {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
}

/** Serialize publication and spend for one idea. A crash leaves an inspectable lock. */
export function claimIdeaResearch(root: string, ideaPath: string): () => void {
  const relative = ideaPath.replace(/\.md$/, '.research.lock');
  const file = taskPath(root, relative);
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch {
    throw new Error('Research for this idea is already running or storage is unavailable');
  }
  const owned = fs.fstatSync(fd);
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  } finally {
    fs.closeSync(fd);
  }
  return () => {
    const current = fs.lstatSync(taskPath(root, relative));
    if (
      !current.isFile() ||
      current.ino !== owned.ino ||
      current.dev !== owned.dev ||
      current.nlink !== 1
    )
      throw new Error('Research lock changed during the run');
    fs.unlinkSync(file);
  };
}

export function featureRequestInput(root: string, file: string) {
  const relative = path.relative(root, path.resolve(root, file));
  const request = readHumanFeatureInput(root, relative);
  return { request, research: readIdeaResearch(root, relative, request) };
}
