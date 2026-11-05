import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RESEARCHER_SPEC } from '../../../core/src/agentSpec.js';
import type { ProjectConfig } from '../../../core/src/project.js';
import {
  type ResearchMode,
  type ResearchReport,
  type SourceItem,
  type SourceKind,
} from '../../../core/src/research.js';
import { AuditLog } from '../auditLog.js';
import { CliUsageError } from '../cliErrors.js';
import {
  RESEARCH_COST_LABEL,
  RESEARCH_QUESTION_CHARS,
  RESEARCH_SEED_LIMIT,
  RESEARCH_TOPICS,
} from '../constants.js';
import { ClaudeCliExecutor } from '../executors/claudeCliExecutor.js';
import type { Executor } from '../executors/executor.js';
import { confirmHumanIngress, featureIngressActor } from '../featureIngress.js';
import {
  claimIdeaResearch,
  ideaResearchPath,
  reportHandoff,
  researchMarkdown,
  type SavedResearch,
  writeIdeaResearch,
} from '../ideaResearch.js';
import { resolveClaudeBinary } from '../modelTiers.js';
import { resolveInside } from '../pathGuard.js';
import { loadProjectConfig } from '../projectConfig.js';
import {
  RESEARCH_MODEL_SCHEMA,
  ResearchAdapters,
  sourceHash,
  validateResearchReport,
  validateSourceItem,
} from '../research.js';
import { booksAdapter } from '../researchAdapters/books.js';
import { paperAdapter } from '../researchAdapters/papers.js';
import { redditAdapter } from '../researchAdapters/reddit.js';
import { webAdapter } from '../researchAdapters/web.js';
import { isYoutube, youtubeAdapter } from '../researchAdapters/youtube.js';
import { researchFailureReason } from '../researchHttp.js';
import {
  researchCostConfirmation,
  researchDeadline,
  researchEstimate,
  researchPolicy,
} from '../researchPolicy.js';
import { researchBudget } from '../researchRuntime.js';
import { discoverUrls } from '../webScout.js';
import { runResearchReviewCommand } from './researchReview.js';
import { readTaskInput, taskPath } from './taskFiles.js';

export interface ResearchCommandOptions {
  config?: ProjectConfig;
  executor?: Executor;
  adapters?: ResearchAdapters;
  audit?: Pick<AuditLog, 'append'>;
  runtimeDirectory?: string;
}
export async function runResearchCommand(
  argv: string[],
  cwd = process.cwd(),
  log = console.log,
  options: ResearchCommandOptions = {},
): Promise<void> {
  if (argv[0] === 'review') return runResearchReviewCommand(argv, cwd, log, options);
  if (argv[0] === 'run') argv = await confirmHumanIngress(argv);
  const usage =
    'Usage: pixel-agents research review <FEAT-ID> [--mode quick|deep] [--accept-cost estimate,cap] [--json] | run --question <text> [--discover] [--kinds paper,book,web,thread,video] [--mode quick|deep] [--idea FEAT-ID] [--accept-cost estimate,cap] [--since YYYY-MM-DD] [--source <url>...] [--json]';
  if (argv[0] !== 'run') throw new CliUsageError(usage);
  let question = '',
    depth: ResearchMode = 'quick',
    ideaKey: string | undefined,
    acceptedCost: string | undefined,
    since: string | undefined,
    json = false,
    discover = false;
  const seeds: string[] = [],
    seen = new Set<string>();
  let kinds: SourceKind[] | undefined;
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--source' && seen.has(flag)) throw new CliUsageError(usage);
    seen.add(flag);
    if (flag === '--json') json = true;
    else if (flag === '--discover') discover = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new CliUsageError(usage);
      if (flag === '--question') question = value;
      else if (
        flag === '--kinds' &&
        value
          .split(',')
          .every((kind) =>
            ['paper', 'book', 'web', 'article', 'thread', 'video', 'podcast'].includes(kind),
          )
      )
        kinds = value.split(',') as SourceKind[];
      else if (flag === '--mode' && ['quick', 'deep'].includes(value))
        depth = value as ResearchMode;
      else if (flag === '--depth' && ['quick', 'standard', 'deep'].includes(value))
        depth = value === 'standard' ? 'deep' : (value as ResearchMode);
      else if (flag === '--idea' && /^FEAT-\d{3}$/.test(value)) ideaKey = value;
      else if (flag === '--accept-cost') acceptedCost = value;
      else if (
        flag === '--since' &&
        /^\d{4}-\d\d-\d\d$/.test(value) &&
        Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString().slice(0, 10) === value
      )
        since = value;
      else if (flag === '--source') {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          throw new CliUsageError(usage);
        seeds.push(url.href);
      } else throw new CliUsageError(usage);
    }
  }
  if (
    (seen.has('--mode') && seen.has('--depth')) ||
    question.length > RESEARCH_QUESTION_CHARS ||
    seeds.length > RESEARCH_SEED_LIMIT
  )
    throw new CliUsageError(usage);
  if (featureIngressActor() !== 'human')
    throw new Error('Research requires human operator ingress');
  const config = options.config ?? loadProjectConfig(cwd, true);
  if (!config || !config.operator.allowedExecutors.includes('claude'))
    throw new Error('Research requires a bound Project and allowed Claude executor');
  const policy = researchPolicy(depth, config.operator.research);
  const ideaPath = ideaKey ? ideaResearchPath(config.project.id, ideaKey) : undefined;
  const idea = ideaPath ? readTaskInput(config.repoRoot, ideaPath) : undefined;
  if (!question.trim()) throw new CliUsageError(usage);
  const estimateUsd = researchEstimate(policy.maxTokens);
  const confirmation = researchCostConfirmation(estimateUsd, policy.maxCostUsd);
  log(
    JSON.stringify({
      mode: depth,
      estimateUsd,
      capUsd: policy.maxCostUsd,
      label: RESEARCH_COST_LABEL,
      confirmation,
    }),
  );
  if (acceptedCost !== confirmation)
    throw new CliUsageError(
      'Confirm the displayed estimate and cap with --accept-cost ' + confirmation,
    );
  const maxSources = policy.maxSources;
  const id = randomUUID(),
    discardedSources: ResearchReport['discardedSources'] = [],
    gaps: string[] = [],
    sources: SourceItem[] = [];
  const directory = taskPath(config.paths.brain, 'research');
  fs.mkdirSync(directory, { recursive: true });
  const cache = taskPath(directory, 'cache');
  fs.mkdirSync(cache, { recursive: true });
  const audit = options.audit ?? new AuditLog();
  const record = (status: string) =>
    audit.append({
      projectId: config.project.id,
      actorType: 'human',
      actorId: 'operator',
      action: 'research_run',
      resourceType: 'research_report',
      resourceId: id,
      policyDecision: null,
      riskLevel: 'low',
      outcome: { status },
      taskKey: null,
      executionId: id,
    });
  const abort = new AbortController();
  const registry = options.adapters ?? new ResearchAdapters();
  if (!options.adapters) {
    registry.register(webAdapter(policy.search));
    registry.register(redditAdapter(policy.reddit));
    registry.register(paperAdapter('arxiv'));
    registry.register(paperAdapter('semantic-scholar'));
    registry.register(booksAdapter());
    registry.register(youtubeAdapter());
  }
  const add = (items: SourceItem[]) => {
    if (abort.signal.aborted) return;
    for (const candidate of items) {
      const s = validateSourceItem(candidate);
      if (sources.length >= maxSources) {
        gaps.push('Source budget exhausted.');
        break;
      }
      if (since && (!s.publishedAt || s.publishedAt.slice(0, 10) < since)) {
        gaps.push('Sources with missing or older publication dates excluded by --since.');
        continue;
      }
      if (sources.some((v) => v.id === s.id || v.contentHash === s.contentHash)) continue;
      const key = sourceHash(
        `${s.adapter}:${s.url ?? s.citation}:${s.contentHash}:${s.retrievedAt.slice(0, 10)}`,
      );
      const file = resolveInside(cache, `${key}.json`);
      if (fs.existsSync(file)) {
        const cached = validateSourceItem(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (cached.id !== s.id) throw new Error('Cache identity mismatch');
        sources.push(cached);
      } else {
        fs.writeFileSync(file, JSON.stringify(s));
        sources.push(s);
      }
    }
  };
  const release = ideaPath ? claimIdeaResearch(config.repoRoot, ideaPath) : () => {};
  const timer = setTimeout(() => abort.abort(), policy.maxSeconds * 1000);
  try {
    record('started');
    const underlying: Executor =
      options.executor ??
      new ClaudeCliExecutor({
        binary: resolveClaudeBinary(config.operator.binaryPaths?.claude),
        configDir: config.operator.executors?.claude?.configDir,
        runtimeDirectory:
          options.runtimeDirectory ??
          path.join(os.homedir(), '.pixel-agents', 'research-runtime', id),
      });
    const budget = researchBudget(underlying, policy, abort, gaps);
    const { executor } = budget;
    try {
      if (discover) {
        const result = await researchDeadline(
          discoverUrls(
            executor,
            {
              executionId: `${id}-scout`,
              projectId: config.project.id,
              taskKey: `scout-${id}`,
              flags: [],
              prompt: '',
              worktreePath: config.repoRoot,
              timeoutMin: policy.maxSeconds / 60,
            },
            question,
            maxSources,
            policy.maxTokens,
            abort.signal,
          ),
          abort.signal,
        );
        seeds.push(...result.urls.filter((url) => !seeds.includes(url)));
      }
      const selected = registry
        .all()
        .filter((adapter) => !kinds || adapter.kinds.some((kind) => kinds.includes(kind)));
      // Share the source budget so the first adapter (arXiv) cannot starve the others.
      const searchShare = Math.max(1, Math.ceil(maxSources / Math.max(1, selected.length)));
      for (const adapter of selected) {
        if (adapter.unavailable) gaps.push(adapter.unavailable);
        const refs = seeds.filter((ref) =>
          adapter.id === 'youtube'
            ? isYoutube(ref)
            : adapter.id === 'reddit'
              ? /^(www\.)?reddit\.com$/.test(new URL(ref).hostname)
              : adapter.id === 'web'
                ? !isYoutube(ref) && !/^(www\.)?reddit\.com$/.test(new URL(ref).hostname)
                : true,
        );
        const operations = [
          ...(adapter.fetch
            ? refs.map((ref) => ({
                ref,
                run: () =>
                  adapter.fetch!(ref, {
                    question,
                    limit: maxSources - sources.length,
                    since,
                    signal: abort.signal,
                  }),
              }))
            : []),
          ...(adapter.search
            ? [
                {
                  ref: undefined,
                  run: () =>
                    adapter.search!(question, {
                      limit: Math.min(searchShare, maxSources - sources.length),
                      since,
                      signal: abort.signal,
                    }),
                },
              ]
            : []),
        ];
        for (const operation of operations) {
          if (abort.signal.aborted || budget.stopReason || sources.length >= maxSources) {
            gaps.push('Collection budget exhausted; coverage is partial.');
            break;
          }
          try {
            const items = await researchDeadline(operation.run(), abort.signal);
            if (items.some((s) => s.adapter !== adapter.id || !adapter.kinds.includes(s.kind)))
              throw new Error('Adapter result identity mismatch');
            add(items);
          } catch (error) {
            const reason = researchFailureReason(error);
            gaps.push(`${adapter.id}: ${reason}.`);
            if (operation.ref) discardedSources.push({ id: operation.ref, reason });
          }
        }
      }
    } catch {
      gaps.push(
        budget.stopReason ??
          (abort.signal.aborted
            ? 'Time budget exhausted.'
            : 'Discovery failed; evidence is partial.'),
      );
    }
    let report: ResearchReport = {
      summary: 'Insufficient evidence.',
      findings: [],
      contradictions: [],
      gaps: [],
      discardedSources: [],
      bibliography: sources,
    };
    try {
      if (sources.length && !abort.signal.aborted && !budget.stopReason) {
        if (executor.id !== 'claude')
          throw new Error('Researcher requires a read-tools-only Claude executor');
        // The CLI's own structured-output check is not deterministic for the model: one retry
        // on a schema rejection (as the Architect corrects validation errors once).
        for (let attempt = 0; ; attempt++) {
          try {
            const handle = executor.start({
              executionId: id,
              projectId: config.project.id,
              taskKey: `research-${id}`,
              role: 'researcher',
              agentSpec: RESEARCHER_SPEC,
              flags: [],
              worktreePath: config.repoRoot,
              timeoutMin: policy.maxSeconds / 60,
              prompt: '',
              taskData: {
                task: {
                  question,
                  depth,
                  ...(idea ? { idea } : {}),
                  ...(since ? { since } : {}),
                  sources,
                  discardedSources,
                  collectionNote:
                    'Failed seed URLs are runtime-owned discardedSources. You may mention these failures in the summary; return only bibliography source IDs in your discardedSources.',
                },
                outputSchema: RESEARCH_MODEL_SCHEMA,
              },
            });
            const cancel = () => handle.cancel();
            abort.signal.addEventListener('abort', cancel, { once: true });
            let output: string | undefined,
              exhausted = false,
              usageObserved = false;
            try {
              for await (const event of handle.events) {
                if (event.type === 'usage') {
                  usageObserved = true;
                  if (
                    !Number.isFinite(event.inputTokens) ||
                    event.inputTokens < 0 ||
                    !Number.isFinite(event.outputTokens) ||
                    event.outputTokens < 0
                  )
                    throw new Error('Invalid research usage');
                  if (budget.usedTokens >= policy.maxTokens) {
                    exhausted = true;
                    handle.cancel();
                  }
                }
                if (event.type === 'finished') {
                  if (event.exitCode !== 0 && !exhausted && !abort.signal.aborted) {
                    if (/schema validation/i.test(event.resultSummary))
                      throw new Error('Research output failed schema validation');
                    throw new Error('Research executor failed');
                  }
                  if (event.exitCode === 0) output = event.resultSummary;
                }
              }
              if (!usageObserved) {
                exhausted = true;
                gaps.push('Executor token usage unavailable; synthesis discarded.');
              }
              if (exhausted || abort.signal.aborted)
                gaps.push('Token/time budget exhausted; synthesis is partial.');
              else if (!output) throw new Error('Researcher returned no report');
              if (output && !exhausted && !abort.signal.aborted)
                report = validateResearchReport(output, sources);
            } finally {
              handle.cancel();
              abort.signal.removeEventListener('abort', cancel);
            }
            break;
          } catch (error) {
            if (
              attempt === 0 &&
              !abort.signal.aborted &&
              !budget.stopReason &&
              /schema validation/i.test((error as Error).message)
            )
              continue;
            throw error;
          }
        }
      }
    } catch {
      gaps.push(
        budget.stopReason ??
          (abort.signal.aborted
            ? 'Time budget exhausted.'
            : 'Synthesis failed; no validated claims produced.'),
      );
    }
    if (budget.stopReason || abort.signal.aborted)
      gaps.push(budget.stopReason ?? 'Time budget exhausted.');
    report.gaps.push(...new Set(gaps));
    report.discardedSources.push(...discardedSources);
    if (ideaPath)
      for (const topic of RESEARCH_TOPICS)
        if (!report.findings.some((finding) => finding.topic === topic))
          report.gaps.push(`Insufficient evidence for ${topic}.`);
    if (!report.findings.length)
      report.gaps.push('Insufficient evidence; no validated claims produced.');
    const result: SavedResearch = {
      kind: 'idea-research-report',
      provenance: 'untrusted-external',
      id,
      mode: depth,
      partial: report.gaps.length > 0,
      report,
      ...(idea ? { ideaHash: sourceHash(idea) } : {}),
      cost: {
        estimateUsd,
        capUsd: policy.maxCostUsd,
        usedEstimateUsd: budget.usedEstimateUsd,
        label: RESEARCH_COST_LABEL,
        ...(budget.stopReason ? { stopReason: budget.stopReason } : {}),
      },
    };
    // Separate, bounded artifact for downstream tool roles. The full report/cache
    // stays tainted evidence; stripping bibliography alone would retain long quotes.
    const handoff = reportHandoff(report);
    handoff.insufficientEvidence ||= result.partial;
    fs.writeFileSync(resolveInside(directory, `${id}.handoff.json`), JSON.stringify(handoff));
    fs.writeFileSync(resolveInside(directory, `${id}.json`), JSON.stringify(result, null, 2));
    fs.writeFileSync(resolveInside(directory, `${id}.md`), researchMarkdown(result));
    if (ideaPath) writeIdeaResearch(config.repoRoot, ideaPath, result);
    record(result.partial ? 'partial' : 'completed');
    log(
      json
        ? JSON.stringify({
            id,
            partial: result.partial,
            path: resolveInside(directory, `${id}.md`),
            cost: result.cost,
          })
        : `Research ${id}: ${resolveInside(directory, `${id}.md`)}${result.partial ? ' (partial; see gaps)' : ''}`,
    );
  } catch (error) {
    record('failed');
    throw error;
  } finally {
    clearTimeout(timer);
    release();
  }
}
