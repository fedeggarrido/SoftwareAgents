import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as contract from '../../../core/schemas/design-report.schema.json';
import { PRODUCT_DESIGNER_SPEC } from '../../../core/src/agentSpec.js';
import type { ProjectConfig } from '../../../core/src/project.js';
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
import { featureIngressActor } from '../featureIngress.js';
import { resolveClaudeBinary } from '../modelTiers.js';
import { resolveInside } from '../pathGuard.js';
import { loadProjectConfig } from '../projectConfig.js';

interface DesignCommandOptions {
  config?: ProjectConfig;
  executor?: Executor;
  capture?: (input: CaptureInput) => Promise<DesignEvidence>;
  audit?: Pick<AuditLog, 'append'>;
  runtimeDirectory?: string;
}

/** Human ingress only. No feature lifecycle transitions or correction loop in phase 1. */
export async function runDesignCommand(
  argv: string[],
  cwd = process.cwd(),
  log = console.log,
  options: DesignCommandOptions = {},
): Promise<void> {
  const usage =
    'Usage: pixel-agents design review [--views office,features,audit,backlog,hud] [--json]';
  if (argv[0] !== 'review') throw new CliUsageError(usage);
  let views: DesignView[] = [...DESIGN_VIEWS];
  let json = false,
    selected = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--json' && !json) json = true;
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
  if (featureIngressActor() !== 'human')
    throw new Error('Design review requires human operator ingress');
  const config = options.config ?? loadProjectConfig(cwd, true);
  if (!config) throw new Error('Design review requires a bound Project');
  if (!config.operator.allowedExecutors.includes('claude'))
    throw new Error('Designer requires an allowed read-tools-only Claude executor');
  const id = randomUUID();
  const directory = resolveInside(config.paths.brain, `design-reviews/${id}`);
  fs.mkdirSync(directory, { recursive: true });
  const runtimeDirectory =
    options.runtimeDirectory ?? path.join(os.homedir(), '.pixel-agents', 'design-runtime', id);
  const audit = options.audit ?? new AuditLog();
  const entry = (status: string): AuditInput => ({
    projectId: config.project.id,
    actorType: 'human',
    actorId: 'operator',
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
    const evidence = await (options.capture ?? captureDesign)({
      tree: config.repoRoot,
      directory,
      views,
    });
    fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
    const executor =
      options.executor ??
      new ClaudeCliExecutor({
        binary: resolveClaudeBinary(config.operator.binaryPaths?.claude),
        configDir: config.operator.executors?.claude?.configDir,
        runtimeDirectory,
      });
    if (executor.id !== 'claude') throw new Error('Designer requires read-tools-only executor');
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
          instruction: 'Read every runtime PNG. Copy validations exactly. Return DesignReport.',
        },
        outputSchema: contract,
      },
    });
    let source: string | undefined;
    try {
      for await (const event of handle.events) {
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
