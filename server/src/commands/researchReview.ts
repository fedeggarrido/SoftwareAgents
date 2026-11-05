import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

import { RESEARCHER_SPEC } from '../../../core/src/agentSpec.js';
import type { ResearchMode } from '../../../core/src/research.js';
import { CliUsageError } from '../cliErrors.js';
import {
  FEATURE_RESEARCH_EVIDENCE_NOTICE,
  RESEARCH_COST_LABEL,
  USAGE_BUDGET_MINUTE_MS,
  USAGE_BUDGET_SECOND_MS,
} from '../constants.js';
import { ClaudeCliExecutor } from '../executors/claudeCliExecutor.js';
import { confirmHumanIngress, featureIngressActor } from '../featureIngress.js';
import {
  emptyFeatureResearch,
  FEATURE_RESEARCH_SCHEMA,
  featureResearchDirectory,
  featureResearchInput,
  type SavedFeatureResearch,
  validateFeatureResearch,
  writeFeatureResearch,
} from '../featureResearch.js';
import { resolveClaudeBinary } from '../modelTiers.js';
import { loadProjectConfig } from '../projectConfig.js';
import { researchCostConfirmation, researchEstimate, researchPolicy } from '../researchPolicy.js';
import { researchBudget } from '../researchRuntime.js';
import type { ResearchCommandOptions } from './research.js';

const USAGE =
  'Usage: pixel-agents research review <FEAT-ID> [--mode quick|deep] [--accept-cost estimate,cap] [--json] [--confirm]';

/** Human-only, explicit observation. No WorkStore writer, pipeline or office ingress. */
export async function runResearchReviewCommand(
  argv: string[],
  cwd: string,
  log: (message: string) => void,
  options: ResearchCommandOptions = {},
): Promise<void> {
  argv = await confirmHumanIngress(argv);
  if (featureIngressActor() !== 'human')
    throw new Error('Research review requires human operator ingress');
  const [command, key] = argv;
  if (command !== 'review' || !/^FEAT-\d{3}$/.test(key ?? '')) throw new CliUsageError(USAGE);
  let mode: ResearchMode = 'quick',
    acceptedCost: string | undefined,
    json = false;
  const seen = new Set<string>();
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw new CliUsageError(USAGE);
    seen.add(flag);
    if (flag === '--json') json = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new CliUsageError(USAGE);
      if (flag === '--mode' && (value === 'quick' || value === 'deep')) mode = value;
      else if (flag === '--accept-cost') acceptedCost = value;
      else throw new CliUsageError(USAGE);
    }
  }
  const config = options.config ?? loadProjectConfig(cwd, true);
  if (!config || !config.operator.allowedExecutors.includes('claude'))
    throw new Error('Research requires a bound Project and allowed Claude executor');
  const policy = researchPolicy(mode, config.operator.research);
  const estimateUsd = researchEstimate(policy.maxTokens);
  const confirmation = researchCostConfirmation(estimateUsd, policy.maxCostUsd);
  log(
    JSON.stringify({
      mode,
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
  // All validation precedes persistence and model launch.
  const input = featureResearchInput(config, key);
  const id = randomUUID();
  const underlying =
    options.executor ??
    new ClaudeCliExecutor({
      binary: resolveClaudeBinary(config.operator.binaryPaths?.claude),
      configDir: config.operator.executors?.claude?.configDir,
      runtimeDirectory:
        options.runtimeDirectory ??
        path.join(os.homedir(), '.pixel-agents', 'research-runtime', id),
    });
  if (underlying.id !== 'claude')
    throw new Error('Researcher requires a read-tools-only Claude executor');
  const abort = new AbortController(),
    gaps: string[] = [];
  const budget = researchBudget(underlying, policy, abort, gaps);
  const timer = setTimeout(() => abort.abort(), policy.maxSeconds * USAGE_BUDGET_SECOND_MS);
  const interrupt = () => {
    gaps.push('Review interrupted by operator; report is partial.');
    abort.abort();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let report = emptyFeatureResearch(input);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const handle = budget.executor.start({
          executionId: `${id}-${attempt}`,
          projectId: config.project.id,
          taskKey: `research-review-${key}`,
          role: 'researcher',
          agentSpec: { ...RESEARCHER_SPEC, outputs: ['FeatureResearchReview'] },
          flags: [],
          worktreePath: config.repoRoot,
          timeoutMin: (policy.maxSeconds * USAGE_BUDGET_SECOND_MS) / USAGE_BUDGET_MINUTE_MS,
          prompt: '',
          taskData: {
            // The bound sources already appear as items; bibliography is in preResearch.
            // Keep the provenance map runtime-only and avoid copying full artifacts twice.
            task: {
              kind: 'feature-research-review',
              provenance: 'untrusted-external',
              key: input.key,
              branch: input.branch,
              base: input.base,
              head: input.head,
              items: input.items,
              diff: input.diff,
              evidence: input.evidence,
              preResearch: input.preResearch,
              deliveryRefs: [...input.branchEvidence.keys()],
              externalRefs: input.bibliography.map((source, index) => ({
                ref: `external:${index}`,
                sourceId: source.id,
              })),
            },
            outputSchema: FEATURE_RESEARCH_SCHEMA,
          },
        });
        let output: string | undefined,
          usageObserved = false;
        try {
          for await (const event of handle.events) {
            if (event.type === 'usage') usageObserved = true;
            if (event.type === 'finished') {
              if (event.exitCode !== 0) {
                if (/schema validation/i.test(event.resultSummary))
                  throw new Error('Feature research output failed schema validation');
                throw new Error('Research review executor failed');
              }
              output = event.resultSummary;
            }
          }
          if (!usageObserved || abort.signal.aborted) {
            gaps.push(
              'Token/time budget exhausted or usage unavailable; no validated comparison produced.',
            );
          } else if (output) report = validateFeatureResearch(output, input);
          else throw new Error('Research review returned no report');
        } finally {
          handle.cancel();
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
        // Fixed diagnostics only: never log model output, Git diff or exception text.
        gaps.push('Review stopped or failed; comparison is partial.');
        break;
      }
    }
    if (budget.stopReason || abort.signal.aborted)
      gaps.push(budget.stopReason ?? 'Time budget exhausted.');
    if (budget.stopReason?.includes('preflight'))
      gaps.push(`Omitted review items: ${input.items.map((item) => item.id).join(', ')}.`);
    const result: SavedFeatureResearch = {
      kind: 'feature-research-review',
      provenance: 'untrusted-external',
      id,
      feature: key,
      mode,
      partial: gaps.length > 0 || report.coverage.some((row) => row.status === 'not verifiable'),
      branch: input.branch,
      base: input.base,
      head: input.head,
      items: input.items,
      report,
      evidenceNotice: FEATURE_RESEARCH_EVIDENCE_NOTICE,
      bibliography: input.bibliography,
      gaps,
      cost: {
        estimateUsd,
        capUsd: policy.maxCostUsd,
        usedEstimateUsd: budget.usedEstimateUsd,
        label: RESEARCH_COST_LABEL,
        ...(budget.stopReason ? { stopReason: budget.stopReason } : {}),
      },
    };
    const reportPath = writeFeatureResearch(featureResearchDirectory(config, key), result);
    log(
      json
        ? JSON.stringify({ id, partial: result.partial, path: reportPath, cost: result.cost })
        : `Feature research ${key}: ${reportPath}${result.partial ? ' (partial)' : ''}`,
    );
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
