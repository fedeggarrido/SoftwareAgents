import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { DesignReport } from '../../core/src/designReport.js';
import type { ProjectConfig } from '../../core/src/project.js';
import { runDesignCommand } from './commands/design.js';
import { captureDesign, DESIGN_CAPTURE_TIMEOUT_MS } from './designCapture.js';
import {
  DESIGN_MAX_ROUNDS,
  DESIGN_MAX_TOKENS,
  needsDesignReview,
  validateDesignRound,
} from './designReviewLoop.js';
import { runVerifierCommand } from './evalCriteria.js';
import { evalGit } from './evalTasks.js';
import { QaSnapshot } from './qaSnapshot.js';
import type { FeatureRunState, TaskRecord, WorkStore } from './workstore/WorkStore.js';

/** Called only by the runner after Reviewer approval and before QA. Persist the
 * attempt before execution: a crash cannot silently reset its budget. */
export async function runDesignGate(
  store: WorkStore,
  config: ProjectConfig,
  state: FeatureRunState,
  task: TaskRecord,
  save: () => Promise<void>,
  reviewCommand = runDesignCommand,
): Promise<boolean> {
  if (!task.declaration || !needsDesignReview(JSON.parse(task.declaration))) return true;
  const review = task.review_ref;
  if (!review || !task.worktree_ref) throw new Error('Design gate requires task review tree');
  const checkpoint = ((state.designReviews ??= {})[task.key] ??= {
    rounds: 0,
    tokens: 0,
    history: [],
  });
  if (checkpoint.approvedSha === review.sha) return true;
  const maxRounds = config.operator.orchestrator?.designMaxRounds ?? DESIGN_MAX_ROUNDS;
  const maxTokens = config.operator.orchestrator?.designMaxTokens ?? DESIGN_MAX_TOKENS;
  if (
    !Number.isSafeInteger(maxRounds) ||
    maxRounds < 1 ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1
  )
    throw new Error('Invalid design limits');
  const escalate = async (reason: string) => {
    await store.openOrJoinIdleDecision({
      id: randomUUID(),
      context: `design-review/${task.key}\n${reason}\nAntes/después: ${checkpoint.history.map((h) => `${h.sha}: ${h.evidenceDirectory}`).join('\n')}\nCaptura de intento pendiente: ${checkpoint.pendingEvidenceDirectory ?? 'no capturada; no verificada'}`,
      blocks: [task.key],
      requestedBy: 'product-designer',
      options: [
        {
          id: 'review',
          label: 'Revisar capturas y findings',
          benefit: 'Resolver desacuerdos de diseño',
          cost: 'Tiempo del operador',
          risk: 'Persisten hallazgos sin resolver',
        },
        {
          id: 'stop',
          label: 'Detener',
          benefit: 'No consumir más cuota',
          cost: 'Trabajo pendiente',
          risk: 'Retraso',
        },
      ],
      recommendation: 'Revisar capturas y acordar alcance antes de reintentar',
      disagreement: [],
      impact: 'QA bloqueada; ninguna aprobación automática',
      urgency: 'high',
    });
    return false;
  };
  if (checkpoint.pending || checkpoint.rounds >= maxRounds || checkpoint.tokens >= maxTokens)
    return escalate('Límite de rondas/coste o ejecución interrumpida');
  checkpoint.pending = true;
  checkpoint.rounds++;
  await save();
  try {
    let result: { report: DesignReport; evidenceDirectory: string } | undefined;
    const beforeTokens = checkpoint.tokens;
    await reviewCommand(
      ['review', '--json'],
      task.worktree_ref,
      (line) => {
        result = JSON.parse(line);
      },
      {
        config: { ...config, repoRoot: task.worktree_ref },
        capture: async (input) => {
          const dependencies = fs.realpathSync(path.join(config.repoRoot, 'node_modules'));
          const snapshot = new QaSnapshot(input.directory, dependencies, true);
          const controller = new AbortController();
          try {
            const tree = await snapshot.prepare(
              input.tree,
              false,
              controller.signal,
              DESIGN_CAPTURE_TIMEOUT_MS,
            );
            const home = path.join(input.directory, 'build-home');
            fs.mkdirSync(home, { recursive: true });
            // Vite's runner avoids writing bundle caches through node_modules junctions.
            // The project's existing config uses __dirname, normally injected by its bundler.
            const built = await runVerifierCommand(
              [
                process.execPath,
                '--import',
                'data:text/javascript,globalThis.__dirname=process.cwd()',
                path.join(dependencies, 'vite/bin/vite.js'),
                'build',
                '--configLoader',
                'runner',
              ],
              path.join(tree, 'webview-ui'),
              home,
              DESIGN_CAPTURE_TIMEOUT_MS,
              controller.signal,
            );
            if (built !== 'pass') throw new Error('Design capture snapshot build failed');
            return await captureDesign({ ...input, tree });
          } finally {
            snapshot.dispose();
          }
        },
        pipeline: {
          assertRevision: () => {
            if (
              evalGit(task.worktree_ref!, ['rev-parse', 'HEAD']) !== review.sha ||
              evalGit(task.worktree_ref!, ['status', '--porcelain', '--untracked-files=all'])
            )
              throw new Error('Design review tree changed; human reconciliation required');
            const current = store.getTask(task.key);
            if (current?.version !== task.version || current.review_ref?.sha !== review.sha)
              throw new Error('Design review task changed; human reconciliation required');
          },
          previousFindings: checkpoint.history.flatMap((h) => h.report.findings),
          onEvidence: async (directory) => {
            checkpoint.pendingEvidenceDirectory = directory;
            await save();
          },
          maxTokens: maxTokens - checkpoint.tokens,
          onUsage: async (tokens) => {
            if (!Number.isSafeInteger(tokens) || tokens < 0)
              throw new Error('Invalid design usage');
            checkpoint.tokens += tokens;
            await save();
          },
        },
      },
    );
    if (!result) throw new Error('Designer returned no pipeline result');
    if (checkpoint.tokens === beforeTokens)
      throw new Error('Design usage unknown; cost budget cannot be verified');
    validateDesignRound(
      result.report,
      checkpoint.history.flatMap((h) => h.report.findings),
    );
    checkpoint.history.push({ sha: review.sha, ...result });
    checkpoint.pending = false;
    delete checkpoint.pendingEvidenceDirectory;
    if (result.report.verdict === 'approve') checkpoint.approvedSha = review.sha;
    await save();
    if (checkpoint.approvedSha === review.sha) return true;
    if (checkpoint.rounds >= maxRounds || checkpoint.tokens >= maxTokens)
      return escalate('Límite de rondas/coste');
    await store.requestDesignRework(task.key, task.version);
    return false;
  } catch (error) {
    await save();
    return escalate(`Revisión de diseño sin aprobación: ${(error as Error).message}`);
  }
}
