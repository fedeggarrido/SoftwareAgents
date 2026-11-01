import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as contract from '../../../core/schemas/design-report.schema.json';
import { PRODUCT_DESIGNER_SPEC } from '../../../core/src/agentSpec.js';
import type { ProjectConfig } from '../../../core/src/project.js';
import {
  applyDirectionTokens,
  ART_DIRECTION_SCHEMA,
  DIRECTION_SYSTEM_SCHEMA,
  hexToOklch,
  SimilarDirectionsError,
  validateArtDirection,
  validateDirectionSystem,
} from '../artDirection.js';
import { type AuditInput, AuditLog } from '../auditLog.js';
import { CliUsageError } from '../cliErrors.js';
import {
  captureDesign,
  type CaptureInput,
  DESIGN_VIEWS,
  type DesignEvidence,
  type DesignView,
} from '../designCapture.js';
import { validateDesignReport } from '../designer.js';
import { ClaudeCliExecutor } from '../executors/claudeCliExecutor.js';
import type { Executor } from '../executors/executor.js';
import {
  confirmHumanIngress,
  featureIngressActor,
  withoutOperatorToken,
} from '../featureIngress.js';
import { resolveClaudeBinary } from '../modelTiers.js';
import { resolveInside } from '../pathGuard.js';
import { loadProjectConfig } from '../projectConfig.js';
import { openWorkStore } from '../workstore/SqliteWorkStore.js';
import type { WorkStore } from '../workstore/WorkStore.js';
import { taskPath } from './taskFiles.js';

interface DesignCommandOptions {
  pipeline?: {
    previousFindings: import('../../../core/src/designReport.js').DesignReport['findings'];
    maxTokens: number;
    onUsage: (tokens: number) => Promise<void>;
    onEvidence?: (directory: string) => Promise<void>;
    assertRevision?: () => void;
  };
  config?: ProjectConfig;
  executor?: Executor;
  capture?: (input: CaptureInput) => Promise<DesignEvidence>;
  audit?: Pick<AuditLog, 'append'>;
  runtimeDirectory?: string;
  store?: WorkStore;
  proposalTree?: (id: string) => string;
}

/** Explicit human ingress for directions; the runner may request a bounded read-only review. */
export async function runDesignCommand(
  argv: string[],
  cwd = process.cwd(),
  log = console.log,
  options: DesignCommandOptions = {},
): Promise<void> {
  if (!(argv[0] === 'review' && options.pipeline)) argv = await confirmHumanIngress(argv);
  const usage =
    'Usage: pixel-agents design review|direction [--views office,features,audit,backlog,hud] [--json] | apply-direction --decision <id> [--json]';
  const mode = argv[0];
  if (!['review', 'direction', 'apply-direction'].includes(mode)) throw new CliUsageError(usage);
  let decisionId: string | undefined;
  let views: DesignView[] = [...DESIGN_VIEWS];
  let json = false,
    selected = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--json' && !json) json = true;
    else if (argv[i] === '--decision' && mode === 'apply-direction' && !decisionId && argv[i + 1])
      decisionId = argv[++i];
    else if (argv[i] === '--views' && !selected && argv[i + 1]) {
      const values = argv[++i].split(',');
      if (
        values.some((v) => !DESIGN_VIEWS.includes(v as DesignView)) ||
        new Set(values).size !== values.length
      )
        throw new CliUsageError(usage);
      views = values as DesignView[];
      selected = true;
    } else throw new CliUsageError(usage);
  }
  if (featureIngressActor() !== 'human' && !(mode === 'review' && options.pipeline))
    throw new Error('Design review requires human operator ingress');
  const config = options.config ?? loadProjectConfig(cwd, true);
  if (!config) throw new Error('Design review requires a bound Project');
  if (!config.operator.allowedExecutors.includes('claude'))
    throw new Error('Designer requires an allowed read-tools-only Claude executor');
  if (mode === 'apply-direction' && !decisionId)
    throw new CliUsageError('apply-direction --decision <id>');
  const id = randomUUID();
  const directory = resolveInside(config.paths.brain, `design-reviews/${id}`);
  fs.mkdirSync(directory, { recursive: true });
  const runtimeDirectory =
    options.runtimeDirectory ?? path.join(os.homedir(), '.pixel-agents', 'design-runtime', id);
  const audit = options.audit ?? new AuditLog();
  const entry = (status: string): AuditInput => ({
    projectId: config.project.id,
    actorType: options.pipeline ? 'system' : 'human',
    actorId: options.pipeline ? 'feature-run' : 'operator',
    action: 'design_review',
    resourceType: 'design_report',
    resourceId: id,
    policyDecision: null,
    riskLevel: 'low',
    outcome: { status },
    taskKey: null,
    executionId: id,
  });
  audit.append(entry('started'));
  try {
    options.pipeline?.assertRevision?.();
    const evidence = await (options.capture ?? captureDesign)({
      tree: config.repoRoot,
      directory,
      views,
    });
    fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
    await options.pipeline?.onEvidence?.(directory);
    if (
      !evidence.images.length ||
      !evidence.validations.some((v) => v.kind === 'capture' && v.result === 'pass')
    )
      throw new Error('Real runtime capture required');
    const executor =
      options.executor ??
      new ClaudeCliExecutor({
        binary: resolveClaudeBinary(config.operator.binaryPaths?.claude),
        configDir: config.operator.executors?.claude?.configDir,
        runtimeDirectory,
      });
    if (executor.id !== 'claude') throw new Error('Designer requires read-tools-only executor');
    const execute = async (task: object, outputSchema: Record<string, unknown>) => {
      const handle = executor.start({
        executionId: id,
        projectId: config.project.id,
        taskKey: `design-${id}`,
        role: 'product-designer',
        agentSpec: PRODUCT_DESIGNER_SPEC,
        flags: [],
        worktreePath: config.repoRoot,
        timeoutMin: 10,
        prompt: '',
        taskData: {
          task: {
            views,
            images: evidence.images,
            validations: evidence.validations,
            instruction:
              'Read every runtime PNG and return DesignReport. Leave validations empty; runtime attaches its evidence.',
            // Compiler input is strict JSON: omit absent pipeline context instead of `undefined`.
            ...(options.pipeline?.previousFindings
              ? { previousFindings: options.pipeline.previousFindings }
              : {}),
            ...task,
          },
          outputSchema,
        },
      });
      let source: string | undefined;
      let tokens = 0;
      try {
        for await (const event of handle.events) {
          if (event.type === 'usage' && options.pipeline) {
            tokens += event.inputTokens + event.outputTokens;
            await options.pipeline.onUsage(event.inputTokens + event.outputTokens);
            if (tokens >= options.pipeline.maxTokens) {
              handle.cancel();
              throw new Error('Design token cost limit exhausted');
            }
          }
          if (event.type === 'finished') {
            if (event.exitCode !== 0)
              throw new Error('Designer execution failed; inspect isolated execution evidence');
            source = event.resultSummary;
          }
        }
      } finally {
        handle.cancel();
      }
      if (!source) throw new Error('Designer returned no report');
      return source;
    };
    if (mode !== 'review') {
      const store =
        options.store ??
        (await openWorkStore({ repositoryPath: config.repoRoot, projectId: config.project.id }));
      try {
        const git = (args: string[]) =>
          execFileSync('git', args, {
            cwd: config.repoRoot,
            encoding: 'utf8',
            windowsHide: true,
          }).trim();
        const treeFor = (key: string) => {
          const tree =
            options.proposalTree?.(key) ??
            resolveInside(config.repoRoot, `.worktrees/design-${key}`);
          if (!options.proposalTree)
            git(['worktree', 'add', '-b', `sa/design-${key}`, tree, 'HEAD']);
          const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
            cwd: tree,
            encoding: 'utf8',
            windowsHide: true,
          }).trim();
          if (!branch.startsWith('sa/design-') || branch === config.project.repo.defaultBranch)
            throw new Error('Direction requires a proposal branch');
          return tree;
        };
        const write = (tree: string, name: string, body: string) => {
          const target = taskPath(tree, `docs/design/${name}.md`);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, body);
        };
        const commitProposal = (tree: string, decision: string, applied: boolean) => {
          const files = ['visual-direction', 'color-system', 'design-system'].map(
            (name) => `docs/design/${name}.md`,
          );
          if (applied) files.push('webview-ui/src/index.css');
          const prettier = path.join(config.repoRoot, 'node_modules/prettier/bin/prettier.cjs');
          if (fs.existsSync(prettier))
            execFileSync(process.execPath, [prettier, '--write', ...files], {
              cwd: tree,
              env: withoutOperatorToken(process.env),
              windowsHide: true,
            });
          const run = (args: string[]) =>
            execFileSync('git', args, {
              cwd: tree,
              windowsHide: true,
              env: withoutOperatorToken({
                ...process.env,
                GIT_AUTHOR_NAME: 'SoftwareAgents Runtime',
                GIT_AUTHOR_EMAIL: 'runtime@softwareagents.local',
                GIT_COMMITTER_NAME: 'SoftwareAgents Runtime',
                GIT_COMMITTER_EMAIL: 'runtime@softwareagents.local',
              }),
            });
          run(['add', '--', ...files]);
          // --only keeps unrelated staged changes out of the runtime's proposal commit.
          run([
            '-c',
            'core.hooksPath=',
            '-c',
            'commit.gpgSign=false',
            'commit',
            '--only',
            '-m',
            `docs(SA-105): ${applied ? 'apply' : 'draft'} art direction decision ${decision}`,
            '--',
            ...files,
          ]);
        };
        if (mode === 'direction') {
          let proposal;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              proposal = validateArtDirection(
                await execute(
                  {
                    operation: 'direction',
                    instruction:
                      'Read runtime PNGs and repository. Return ArtDirectionProposal: >=3 distinct directions; six scores 1..5. recommendation is a direction id. Explain drawbacks. Do not approve or write.',
                    reexplore: attempt > 0,
                  },
                  ART_DIRECTION_SCHEMA,
                ),
              );
              break;
            } catch (error) {
              if (!(error instanceof SimilarDirectionsError) || attempt === 1) throw error;
            }
          }
          if (!proposal) throw new Error('No valid proposal');
          const tree = treeFor(id);
          fs.writeFileSync(
            path.join(directory, 'proposal.json'),
            JSON.stringify(proposal, null, 2),
          );
          write(
            tree,
            'visual-direction',
            `# Dirección artística — borrador pendiente de decisión humana\n\n${proposal.diagnosis}\n\n${proposal.directions.map((d) => `## ${d.name}\n\n${JSON.stringify(d, null, 2)}`).join('\n\n')}\n\nRecomendación: ${proposal.recommendation}\n\nInconvenientes: ${proposal.drawbacks}\n`,
          );
          for (const name of ['color-system', 'design-system'])
            write(
              tree,
              name,
              `# ${name}\n\nBorrador: pendiente de Dirección artística y materialización.\n`,
            );
          commitProposal(tree, id, false);
          const decision = await store.openDecision({
            id,
            context: `art-direction/${id}\nDirección artística\nPropuesta: ${tree}\nCapturas: ${directory}`,
            requestedBy: 'product-designer',
            blocks: [],
            options: proposal.directions.map((d) => ({
              id: d.id,
              label: d.name,
              benefit: d.advantages,
              cost: d.complexity,
              risk: d.risks,
            })),
            recommendation: proposal.recommendation,
            disagreement: [],
            impact: proposal.drawbacks,
            urgency: 'medium',
          });
          audit.append(entry('direction_proposed'));
          log(JSON.stringify({ decision, tree, evidenceDirectory: directory }));
        } else {
          const decision = store.listDecisions().find((d) => d.id === decisionId);
          if (
            !decision ||
            decision.context.split('\n')[0] !== `art-direction/${decisionId}` ||
            decision.status !== 'answered' ||
            !decision.answeredBy ||
            !decision.options.some((o) => o.id === decision.answer)
          )
            throw new Error(
              'Answered human art-direction decision with an exact option id required',
            );
          const original = resolveInside(
            config.paths.brain,
            `design-reviews/${decisionId}/proposal.json`,
          );
          const proposal = validateArtDirection(fs.readFileSync(original, 'utf8'));
          const selectedDirection = proposal.directions.find((d) => d.id === decision.answer);
          if (!selectedDirection) throw new Error('Decision does not match proposal');
          const { system, contrasts } = validateDirectionSystem(
            await execute(
              {
                operation: 'apply-direction',
                selectedDirection,
                instruction:
                  'Return DirectionSystem. colorSystem must describe harmony, HEX + OKLCH palettes, semantic roles, tonal scales, prohibited combinations. designSystem must document typography, layout, components and interaction states. Read webview-ui/src/index.css and supply existing :root CSS token names (this project uses --color-*), never invent unused tokens. Supply all approved token pairs with usage normal/large/non-text. Runtime checks HEX contrast. Never write files or logic.',
              },
              DIRECTION_SYSTEM_SCHEMA,
            ),
          );
          const tree = treeFor(id);
          const cssPath = taskPath(tree, 'webview-ui/src/index.css');
          const css = applyDirectionTokens(fs.readFileSync(cssPath, 'utf8'), system.tokens);
          write(
            tree,
            'visual-direction',
            `# Dirección artística\n\nDecisión humana: ${decisionId}\n\n${JSON.stringify(selectedDirection, null, 2)}\n`,
          );
          write(
            tree,
            'color-system',
            `${system.colorSystem}\n\n## Paleta HEX / OKLCH calculada por runtime\n\n${system.tokens
              .filter((t) => /^#[a-f0-9]{6}$/i.test(t.value))
              .map((t) => `- ${t.name}: ${t.value}; ${hexToOklch(t.value)}`)
              .join(
                '\n',
              )}\n\n## Contrastes verificados por runtime (WCAG sRGB)\n\n${contrasts.map((p) => `- ${p.foreground}/${p.background}: ${p.ratio.toFixed(3)}:1; mínimo ${p.threshold}:1 (${p.usage})`).join('\n')}\n`,
          );
          write(tree, 'design-system', system.designSystem);
          fs.writeFileSync(cssPath, css);
          commitProposal(tree, decisionId!, true);
          audit.append(entry('direction_review_required'));
          log(JSON.stringify({ tree, decisionId, contrasts, status: 'review_required' }));
        }
      } finally {
        if (!options.store) store.close();
      }
      return;
    }
    // ESM loaders wrap JSON in a module namespace; the compiler requires the JSON object.
    const schema = ('default' in contract ? contract.default : contract) as Record<string, unknown>;
    const source = await execute({}, schema);
    options.pipeline?.assertRevision?.();
    const report = validateDesignReport(source, evidence.validations);
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    audit.append(entry(report.verdict));
    log(
      json
        ? JSON.stringify({ report, evidenceDirectory: directory })
        : `${report.verdict}: ${path.join(directory, 'report.json')}`,
    );
  } catch (error) {
    audit.append(entry('failed'));
    throw error;
  }
}
