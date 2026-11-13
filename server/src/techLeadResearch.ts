import { RESEARCHER_SPEC } from '../../core/src/agentSpec.js';
import {
  RESEARCH_QUOTE_CHARS,
  type ResearchReport,
  type SourceItem,
} from '../../core/src/research.js';
import { RESEARCH_QUESTION_CHARS, STACK_RESEARCH_QUESTION } from './constants.js';
import type { ExecutionRequest, Executor } from './executors/executor.js';
import {
  RESEARCH_MODEL_SCHEMA,
  type ResearchAdapters,
  validateResearchReport,
  validateSourceItem,
} from './research.js';
import { webAdapter } from './researchAdapters/web.js';
import { researchDeadline, type researchPolicy } from './researchPolicy.js';
import { discoverUrls } from './webScout.js';

/** The synthesis already contains the evidence. Avoid copying every full excerpt again.
 * Keep original IDs and verified quotes so the Tech Lead can cite the same bibliography. */
export function techLeadEvidence(report: ResearchReport) {
  const { bibliography, ...synthesis } = report;
  return {
    ...synthesis,
    bibliography: bibliography.map((source) => ({
      id: source.id,
      title: source.title,
      url: source.url ?? null,
      citation: source.citation ?? null,
      excerpt: source.excerpt.slice(0, RESEARCH_QUOTE_CHARS),
      quotes: [
        ...new Set(
          report.findings
            .flatMap((finding) => finding.quotes ?? [])
            .filter((quote) => quote.sourceId === source.id)
            .map((quote) => quote.text),
        ),
      ],
    })),
  };
}

/** Shared Researcher + web-scout boundaries, SSRF transport and citation validation. */
export async function researchStack(
  executor: Executor,
  request: Omit<ExecutionRequest, 'role' | 'agentSpec' | 'taskData'>,
  policy: ReturnType<typeof researchPolicy>,
  signal: AbortSignal,
  adapters?: ResearchAdapters,
): Promise<ResearchReport> {
  const sources: SourceItem[] = [];
  const gaps: string[] = [];
  const question = STACK_RESEARCH_QUESTION.slice(0, RESEARCH_QUESTION_CHARS);
  const discovered = await researchDeadline(
    discoverUrls(
      executor,
      { ...request, executionId: `${request.executionId}-scout` },
      question,
      policy.maxSources,
      policy.maxTokens,
      signal,
    ),
    signal,
  );
  const selected = adapters?.all() ?? [webAdapter(policy.search)];
  for (const adapter of selected) {
    if (adapter.unavailable) gaps.push(adapter.unavailable);
    const operations = [
      ...(adapter.fetch
        ? discovered.urls.map(
            (url) => () =>
              adapter.fetch!(url, {
                question,
                limit: policy.maxSources - sources.length,
                signal,
              }),
          )
        : []),
      ...(adapter.search
        ? [
            () =>
              adapter.search!(question, {
                limit: policy.maxSources - sources.length,
                signal,
              }),
          ]
        : []),
    ];
    for (const operation of operations) {
      if (sources.length >= policy.maxSources) break;
      try {
        for (const candidate of await researchDeadline(operation(), signal)) {
          const source = validateSourceItem(candidate);
          if (source.adapter !== adapter.id || !adapter.kinds.includes(source.kind))
            throw new Error('Research adapter identity mismatch');
          if (
            sources.length < policy.maxSources &&
            !sources.some(
              (item) => item.id === source.id || item.contentHash === source.contentHash,
            )
          )
            sources.push(source);
        }
      } catch {
        signal.throwIfAborted();
        gaps.push('No se pudo verificar una fuente de investigación.');
      }
    }
  }
  if (!sources.length) throw new Error('Stack research requires verified sources');
  const output = await researchJson(
    executor,
    {
      ...request,
      executionId: `${request.executionId}-research`,
      role: 'researcher',
      agentSpec: RESEARCHER_SPEC,
      taskData: { task: { question, sources }, outputSchema: RESEARCH_MODEL_SCHEMA },
    },
    signal,
  );
  const report = validateResearchReport(output, sources);
  report.gaps.push(...gaps);
  return report;
}

/** Same usage/deadline requirements as the Researcher CLI, with fixed diagnostics. */
export async function researchJson(
  executor: Executor,
  request: ExecutionRequest,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const handle = executor.start(request);
  const cancel = () => handle.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  let output: string | undefined;
  let observed = false;
  try {
    const iterator = handle.events[Symbol.asyncIterator]();
    for (;;) {
      const next = await researchDeadline(iterator.next(), signal);
      if (next.done) break;
      const event = next.value;
      if (event.type === 'usage') observed = true;
      if (event.type === 'finished') {
        if (event.exitCode !== 0) throw new Error('Research proposal executor failed');
        output = event.resultSummary;
      }
    }
    signal.throwIfAborted();
    if (!observed || !output) throw new Error('Research output or usage unavailable');
    return output;
  } finally {
    cancel();
    signal.removeEventListener('abort', cancel);
  }
}
