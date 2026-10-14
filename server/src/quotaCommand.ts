import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

import * as agentSchema from '../../core/schemas/agent-spec.schema.json';
import type { AgentSpec } from '../../core/src/agentSpec.js';
import type { CapacitySnapshot } from '../../core/src/capacity.js';
import type { WorkSize, WorkType } from '../../core/src/modelTier.js';
import type { ProjectOperatorConfig } from '../../core/src/project.js';
import { CliUsageError } from './cliErrors.js';
import { readConfig } from './configPersistence.js';
import type { ExecutorId } from './executors/executor.js';
import type { SelectionSnapshot } from './executorSelection.js';
import { selectExecutor } from './executorSelection.js';
import { readExecutorSlots, slotProcessIdentity } from './executorSlots.js';
import { retryFileOperation } from './fileContention.js';
import {
  isFreshMachineObservation,
  machineCapacityDirectory,
  type MachineCapacityObservation,
} from './machineCapacity.js';
import { loadModelPolicy, loadTierRule } from './modelPolicy.js';
import { selectModelTier, validateModelTierSupport, WORK_TYPES } from './modelTiers.js';
import { loadProjectConfig } from './projectConfig.js';
import { mergeQuotaEvidence, quotaWindowKey } from './quotaEvidence.js';
import { quotaGate } from './quotaGate.js';
import { compileSchema, validateSchema } from './schemaValidation.js';

const validateObservation = compileSchema<MachineCapacityObservation>({
  type: 'object',
  additionalProperties: false,
  required: ['observedAt', 'publisher', 'coverage', 'sessions', 'capacities'],
  properties: {
    observedAt: { type: 'number' },
    publisher: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'pid', 'bootId', 'sequence'],
      properties: {
        id: { type: 'string', pattern: '^[a-zA-Z0-9-]+$' },
        bootId: { type: 'string', pattern: '^[a-zA-Z0-9-]+$' },
        pid: { type: 'integer', minimum: 1 },
        sequence: { type: 'integer', minimum: 1 },
        startIdentity: { type: 'string' },
      },
    },
    coverage: {
      type: 'object',
      additionalProperties: false,
      required: ['scope', 'workspaces', 'source'],
      properties: {
        scope: { const: 'office' },
        workspaces: { type: 'array', items: { type: 'string' } },
        source: { const: 'office_store' },
      },
    },
    sessions: {
      type: 'object',
      additionalProperties: false,
      required: ['claude', 'codex'],
      properties: {
        claude: { type: 'array', items: { type: 'string', minLength: 1 } },
        codex: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
    },
    capacities: {
      type: 'object',
      propertyNames: { enum: ['claude', 'codex'] },
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['provider', 'status', 'windows', 'source', 'confidence', 'observedAt'],
        properties: {
          provider: { enum: ['claude', 'codex'] },
          status: { enum: ['unknown', 'allowed', 'warning', 'rejected', 'reset'] },
          source: { enum: ['claude_stream_json', 'codex_session_log', 'estimated'] },
          confidence: { enum: ['unknown', 'low', 'high', 'exact'] },
          observedAt: { type: ['number', 'null'] },
          windows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'usedRatio', 'resetsAt'],
              properties: {
                kind: { enum: ['five_hour', 'weekly', 'other'] },
                limitId: { type: 'string' },
                usedRatio: { type: ['number', 'null'], minimum: 0, maximum: 1 },
                resetsAt: { type: ['number', 'null'] },
              },
            },
          },
        },
      },
    },
    evidence: {
      type: 'object',
      propertyNames: { enum: ['claude', 'codex'] },
      additionalProperties: {
        type: 'array',
        items: { $ref: '#/properties/capacities/additionalProperties' },
      },
    },
  },
});

/** Runtime slots are the machine authority. Office contributions only add observed
 * sessions; absent/partial coverage never establishes an interactive-session total.
 */
export function readSelectionSnapshot(
  operator: ProjectOperatorConfig,
  nowS = Date.now() / 1000,
): SelectionSnapshot {
  const policies = Object.values(readConfig().projects);
  const totalLimits = [...policies, operator]
    .map((p) => p.concurrency?.maxExecutions)
    .filter((n): n is number => n !== undefined);
  const maxExecutions = totalLimits.length ? Math.min(...totalLimits) : undefined;
  const maxConcurrent: Partial<Record<ExecutorId, number>> = {};
  for (const executor of ['claude', 'codex'] as const) {
    const limits = policies
      .filter((p) => p.allowedExecutors.includes(executor))
      .map((p) => p.concurrency?.perExecutor?.[executor])
      .filter((n): n is number => n !== undefined);
    if (limits.length && limits.every((n) => n !== undefined))
      maxConcurrent[executor] = Math.min(...(limits as number[]));
  }
  const observations: MachineCapacityObservation[] = [];
  const current: MachineCapacityObservation[] = [];
  const directory = machineCapacityDirectory();
  let files: string[] = [];
  try {
    files = retryFileOperation(() => {
      try {
        return fs.readdirSync(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    }).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const name of files) {
    const file = path.join(directory, name);
    try {
      const observation = validateSchema(
        validateObservation,
        JSON.parse(retryFileOperation(() => fs.readFileSync(file, 'utf8'), 100)),
      );
      observations.push(observation);
      if (isFreshMachineObservation(observation, file, nowS)) current.push(observation);
    } catch {
      /* Invalid contributions confer no favorable evidence. */
    }
  }
  const active: Partial<Record<ExecutorId, number>> = {};
  const capacities: Partial<Record<ExecutorId, CapacitySnapshot>> = {};
  const counts = {
    claude: {
      runtimeSlots: 0,
      observedSessions: 0,
      observedRuntimeSessions: 0,
      blockedSlots: [] as string[],
    },
    codex: {
      runtimeSlots: 0,
      observedSessions: 0,
      observedRuntimeSessions: 0,
      blockedSlots: [] as string[],
    },
  };
  for (const executor of ['claude', 'codex'] as const) {
    const slots = readExecutorSlots(executor);
    const runtimeSessions = new Set(slots.sessions);
    const sessionSources = observations.filter(
      (o) =>
        current.includes(o) ||
        (o.observedAt > nowS &&
          o.publisher.startIdentity &&
          slotProcessIdentity(o.publisher.pid) === o.publisher.startIdentity),
    );
    const observedSessions = new Set(sessionSources.flatMap((o) => o.sessions[executor]));
    active[executor] = slots.count;
    counts[executor] = {
      runtimeSlots: slots.count,
      observedSessions: observedSessions.size,
      observedRuntimeSessions: [...observedSessions].filter((s) => runtimeSessions.has(s)).length,
      blockedSlots: slots.blocked,
    };
    const evidence = mergeQuotaEvidence(
      observations
        .flatMap((o) => o.evidence?.[executor] ?? [o.capacities[executor]])
        .filter((s): s is CapacitySnapshot => !!s),
      nowS,
    );
    if (evidence) {
      const freshEvidence = current
        .flatMap((o) => o.evidence?.[executor] ?? [o.capacities[executor]])
        .filter((s): s is CapacitySnapshot => !!s);
      const backedByFreshPublisher = evidence.windows.every((w) =>
        freshEvidence.some(
          (s) =>
            ['high', 'exact'].includes(s.confidence) &&
            s.windows.some(
              (live) =>
                quotaWindowKey(live) === quotaWindowKey(w) &&
                live.usedRatio === w.usedRatio &&
                live.resetsAt === w.resetsAt,
            ),
        ),
      );
      capacities[executor] = backedByFreshPublisher ? evidence : { ...evidence, confidence: 'low' };
    }
  }
  return {
    allowedExecutors: operator.allowedExecutors,
    ...(operator.executorLevels ? { executorLevels: operator.executorLevels } : {}),
    machinePolicy: {
      quotaThresholds: operator.quotaThresholds ?? {},
      maxConcurrent,
      maxExecutions,
    },
    active,
    coverage: {
      scope: 'runtime_slots',
      interactiveSessions: 'excluded_from_worker_limit',
      counts,
      offices: current.map((o) => o.coverage),
      unobservedInteractiveSessions: 'not_counted',
    },
    capacities,
    nowS,
  };
}

export interface QuotaArgs {
  executor?: ExecutorId;
  role: string;
  json: boolean;
  selectExecutor?: boolean;
  workType?: WorkType;
  size?: WorkSize;
}
export function parseQuotaArgs(argv: string[]): QuotaArgs {
  if (argv[0] !== 'check')
    throw new CliUsageError(
      'Usage: pixel-agents quota check (--executor claude|codex | --select-executor) --role <role> [--work-type <type>] [--size S|M|L] [--json]',
    );
  const values: Record<string, string> = {};
  let json = false;
  let selection = false;
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--select-executor' && !selection) {
      selection = true;
      continue;
    }
    if (key === '--json' && !json) {
      json = true;
      continue;
    }
    if (
      !['--executor', '--role', '--work-type', '--size'].includes(key) ||
      values[key] ||
      !argv[i + 1] ||
      argv[i + 1].startsWith('--')
    )
      throw new CliUsageError('Invalid quota check arguments');
    values[key] = argv[++i];
  }
  if (
    (!selection && !['claude', 'codex'].includes(values['--executor'])) ||
    !values['--role'] ||
    (selection && values['--executor']) ||
    (values['--work-type'] && !(WORK_TYPES as readonly string[]).includes(values['--work-type'])) ||
    (values['--size'] && !['S', 'M', 'L'].includes(values['--size']))
  )
    throw new CliUsageError(
      'Invalid quota arguments: require role and executor or --select-executor; valid work type and size S/M/L',
    );
  return {
    ...(selection ? { selectExecutor: true } : { executor: values['--executor'] as ExecutorId }),
    role: values['--role'],
    json,
    ...(values['--work-type'] ? { workType: values['--work-type'] as WorkType } : {}),
    ...(values['--size'] ? { size: values['--size'] as WorkSize } : {}),
  };
}
export function runQuotaCheck(args: QuotaArgs, cwd = process.cwd(), log = console.log): number {
  const config = loadProjectConfig(cwd, true);
  if (!config) throw new CliUsageError('quota check requires a Project');
  const snapshot = readSelectionSnapshot(config.operator);
  if (args.selectExecutor) {
    if (!['developer', 'reviewer', 'qa', 'architect', 'requirements-analyst'].includes(args.role))
      throw new CliUsageError('Unknown AgentSpec role');
    const bundled = path.join(__dirname, `agents/templates/${args.role}.yaml`);
    const source = path.resolve(__dirname, `../../agents/templates/${args.role}.yaml`);
    const agent = validateSchema(
      compileSchema<AgentSpec>(agentSchema),
      parse(fs.readFileSync(fs.existsSync(bundled) ? bundled : source, 'utf8')),
    );
    const tierPolicy = config.operator.modelTiers;
    if (tierPolicy)
      validateModelTierSupport(
        tierPolicy,
        config.operator.binaryPaths?.claude,
        agent,
        tierPolicy.rule ?? loadTierRule(cwd),
        args,
        snapshot.allowedExecutors,
        snapshot.executorLevels,
      );
    const selected = tierPolicy
      ? selectModelTier(agent, tierPolicy.rule ?? loadTierRule(cwd), tierPolicy, args, snapshot)
      : selectExecutor(agent, loadModelPolicy(cwd), snapshot);
    const result = {
      ...selected.gate,
      role: args.role,
      tier: 'tier' in selected ? selected.tier : null,
      requestedTier: 'requestedTier' in selected ? selected.requestedTier : null,
      executor: selected.choice?.executor ?? null,
      model: selected.choice?.model ?? null,
      effort:
        selected.choice && 'effort' in selected.choice ? (selected.choice.effort ?? null) : null,
      downgrades: 'downgrades' in selected ? selected.downgrades : [],
      reason: selected.reason,
      active: snapshot.active,
      maxExecutions: snapshot.machinePolicy?.maxExecutions ?? null,
      activeTotal: (snapshot.active.claude ?? 0) + (snapshot.active.codex ?? 0),
      coverage: snapshot.coverage,
    };
    log(args.json ? JSON.stringify(result) : `${result.status}: ${result.reason}`);
    return result.status === 'wait' ? 3 : 0;
  }
  const executor = args.executor!;
  const decision = snapshot.allowedExecutors.includes(executor)
    ? quotaGate(
        executor,
        snapshot.machinePolicy,
        snapshot.capacities[executor],
        snapshot.active[executor] ?? NaN,
        snapshot.nowS,
        (snapshot.active.claude ?? 0) + (snapshot.active.codex ?? 0),
      )
    : {
        status: 'wait',
        resetsAt: null,
        reason: `${args.executor}: executor not allowed by Operator config`,
      };
  log(
    args.json
      ? JSON.stringify({
          executor: args.executor,
          role: args.role,
          ...decision,
          active: snapshot.active[executor],
          maxExecutions: snapshot.machinePolicy?.maxExecutions ?? null,
          activeTotal: (snapshot.active.claude ?? 0) + (snapshot.active.codex ?? 0),
          coverage: snapshot.coverage,
        })
      : `${decision.status}: ${decision.reason}`,
  );
  return decision.status === 'wait' ? 3 : 0;
}
