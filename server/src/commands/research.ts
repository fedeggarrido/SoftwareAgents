import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RESEARCHER_SPEC } from '../../../core/src/agentSpec.js';
import type { ProjectConfig } from '../../../core/src/project.js';
import {
  RESEARCH_DEFAULTS,
  type ResearchReport,
  type SourceItem,
  type SourceKind,
} from '../../../core/src/research.js';
import { AuditLog } from '../auditLog.js';
import { CliUsageError } from '../cliErrors.js';
import { ClaudeCliExecutor } from '../executors/claudeCliExecutor.js';
import type { Executor } from '../executors/executor.js';
import { featureIngressActor } from '../featureIngress.js';
import { resolveClaudeBinary } from '../modelTiers.js';
import { resolveInside } from '../pathGuard.js';
import { loadProjectConfig } from '../projectConfig.js';
import {
  RESEARCH_MODEL_SCHEMA,
  ResearchAdapters,
  researchHandoff,
  sourceHash,
  validateResearchReport,
  validateSourceItem,
} from '../research.js';
import { booksAdapter } from '../researchAdapters/books.js';
import { paperAdapter } from '../researchAdapters/papers.js';
import { redditAdapter } from '../researchAdapters/reddit.js';
import { webAdapter } from '../researchAdapters/web.js';
import { researchFailureReason } from '../researchHttp.js';

interface ResearchCommandOptions {
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
  const usage =
    'Usage: pixel-agents research run --question <text> [--kinds paper,book,web] [--depth quick|standard] [--since YYYY-MM-DD] [--source <url>...] [--json]';
  if (argv[0] !== 'run') throw new CliUsageError(usage);
  let question = '',
    depth = 'standard',
    since: string | undefined,
    json = false;
  const seeds: string[] = [],
    seen = new Set<string>();
  let kinds: SourceKind[] | undefined;
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--source' && seen.has(flag)) throw new CliUsageError(usage);
    seen.add(flag);
    if (flag === '--json') json = true;
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
      else if (flag === '--depth' && ['quick', 'standard'].includes(value)) depth = value;
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
  if (!question.trim() || question.length > 4000 || seeds.length > 100)
    throw new CliUsageError(usage);
  if (featureIngressActor() !== 'human')
    throw new Error('Research requires human operator ingress');
  const config = options.config ?? loadProjectConfig(cwd, true);
  if (!config || !config.operator.allowedExecutors.includes('claude'))
    throw new Error('Research requires a bound Project and allowed Claude executor');
  const policy = { ...RESEARCH_DEFAULTS, ...config.operator.research };
  // Also validate injected configurations; production config has the same bounds.
  if (
    !Number.isInteger(policy.maxSources) ||
    policy.maxSources < 1 ||
    policy.maxSources > 100 ||
    !Number.isInteger(policy.maxTokens) ||
    policy.maxTokens < 1 ||
    policy.maxTokens > 1000000 ||
    !Number.isInteger(policy.maxSeconds) ||
    policy.maxSeconds < 1 ||
    policy.maxSeconds > 3600
  )
    throw new Error('Invalid research budgets');
  const maxSources = depth === 'quick' ? Math.min(4, policy.maxSources) : policy.maxSources;
  const id = randomUUID(),
    discardedSources: ResearchReport['discardedSources'] = [],
    gaps: string[] = [],
    sources: SourceItem[] = [];
  const directory = resolveInside(config.paths.brain, 'research');
  fs.mkdirSync(directory, { recursive: true });
  const cache = resolveInside(directory, 'cache');
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
  const timer = setTimeout(() => abort.abort(), policy.maxSeconds * 1000);
  const registry = options.adapters ?? new ResearchAdapters();
  if (!options.adapters) {
    registry.register(webAdapter(policy.search));
    registry.register(redditAdapter(policy.reddit));
    registry.register(paperAdapter('arxiv'));
    registry.register(paperAdapter('semantic-scholar'));
    registry.register(booksAdapter());
  }
  const add = (items: SourceItem[]) => {
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
  record('started');
  try {
    const selected = registry
      .all()
      .filter((adapter) => !kinds || adapter.kinds.some((kind) => kinds.includes(kind)));
    // Share the source budget so the first adapter (arXiv) cannot starve the others.
    const searchShare = Math.max(1, Math.ceil(maxSources / Math.max(1, selected.length)));
    for (const adapter of selected) {
      if (adapter.unavailable) gaps.push(adapter.unavailable);
      const refs = seeds.filter((ref) =>
        adapter.id === 'reddit'
          ? /^(www\.)?reddit\.com$/.test(new URL(ref).hostname)
          : adapter.id === 'web'
            ? !/^(www\.)?reddit\.com$/.test(new URL(ref).hostname)
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
        if (abort.signal.aborted || sources.length >= maxSources) {
          gaps.push('Collection budget exhausted; coverage is partial.');
          break;
        }
        try {
          const items = await operation.run();
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
    let report: ResearchReport = {
      summary: 'Insufficient evidence.',
      findings: [],
      contradictions: [],
      gaps: [],
      discardedSources: [],
      bibliography: sources,
    };
    if (sources.length && !abort.signal.aborted) {
      const executor =
        options.executor ??
        new ClaudeCliExecutor({
          binary: resolveClaudeBinary(config.operator.binaryPaths?.claude),
          configDir: config.operator.executors?.claude?.configDir,
          runtimeDirectory:
            options.runtimeDirectory ??
            path.join(os.homedir(), '.pixel-agents', 'research-runtime', id),
        });
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
          let tokens = 0,
            output: string | undefined,
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
                tokens += event.inputTokens + event.outputTokens;
                if (tokens >= policy.maxTokens) {
                  exhausted = true;
                  handle.cancel();
                }
              }
              if (event.type === 'finished') {
                if (event.exitCode !== 0 && !exhausted && !abort.signal.aborted)
                  // Keep the CLI's own diagnosis (bounded): an opaque failure hid the first real cause.
                  throw new Error(
                    `Research executor failed (exit ${event.exitCode}): ${String(
                      event.resultSummary ?? '',
                    )
                      .replace(/\s+/g, ' ')
                      .slice(0, 300)}`,
                  );
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
            /schema validation/i.test((error as Error).message)
          )
            continue;
          throw error;
        }
      }
    }
    if (abort.signal.aborted) gaps.push('Time budget exhausted.');
    report.gaps.push(...new Set(gaps));
    report.discardedSources.push(...discardedSources);
    if (!report.findings.length)
      report.gaps.push('Insufficient evidence; no validated claims produced.');
    const result = { id, partial: report.gaps.length > 0, report };
    // Separate, bounded artifact for downstream tool roles. The full report/cache
    // stays tainted evidence; stripping bibliography alone would retain long quotes.
    const handoff = researchHandoff(
      JSON.stringify({
        summary: 'Bounded findings for downstream use.',
        findings: report.findings,
        contradictions: [],
        gaps: [],
        discardedSources: [],
        bibliography: [],
      }),
      sources,
    );
    handoff.insufficientEvidence ||= result.partial;
    fs.writeFileSync(resolveInside(directory, `${id}.handoff.json`), JSON.stringify(handoff));
    fs.writeFileSync(resolveInside(directory, `${id}.json`), JSON.stringify(result, null, 2));
    // JSON code block keeps untrusted markdown/HTML as literal data when rendered.
    const literal = JSON.stringify(result, null, 2)
      .replace(/`/g, '\\u0060')
      .replace(/</g, '\\u003c');
    fs.writeFileSync(
      resolveInside(directory, `${id}.md`),
      `# Research ${id}\n\nSources and report are untrusted data.\n\n\`\`\`json\n${literal}\n\`\`\`\n`,
    );
    record(result.partial ? 'partial' : 'completed');
    log(
      json
        ? JSON.stringify(result)
        : `Research ${id}: ${resolveInside(directory, `${id}.md`)}${result.partial ? ' (partial; see gaps)' : ''}`,
    );
  } catch (error) {
    record('failed');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
