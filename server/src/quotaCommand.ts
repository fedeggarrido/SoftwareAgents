import * as fs from 'fs';
import * as path from 'path';

import type { CapacitySnapshot } from '../../core/src/capacity.js';
import type { ProjectOperatorConfig } from '../../core/src/project.js';
import { readConfig } from './configPersistence.js';
import type { ExecutorId } from './executors/executor.js';
import type { SelectionSnapshot } from './executorSelection.js';
import { readExecutorSlots } from './executorSlots.js';
import {
  isFreshMachineObservation,
  machineCapacityDirectory,
  type MachineCapacityObservation,
} from './machineCapacity.js';
import { loadProjectConfig } from './projectConfig.js';
import { mergeQuotaEvidence } from './quotaEvidence.js';
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
  const maxConcurrent: Partial<Record<ExecutorId, number>> = {};
  for (const executor of ['claude', 'codex'] as const) {
    const limits = policies
      .filter((p) => p.allowedExecutors.includes(executor))
      .map((p) => p.concurrency?.perExecutor?.[executor]);
    if (limits.length && limits.every((n) => n !== undefined))
      maxConcurrent[executor] = Math.min(...(limits as number[]));
  }
  const observations: MachineCapacityObservation[] = [];
  const current: MachineCapacityObservation[] = [];
  const directory = machineCapacityDirectory();
  let files: string[] = [];
  try {
    files = fs.readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const name of files) {
    const file = path.join(directory, name);
    try {
      const observation = validateSchema(
        validateObservation,
        JSON.parse(fs.readFileSync(file, 'utf8')),
      );
      observations.push(observation);
      if (isFreshMachineObservation(observation, file, nowS)) current.push(observation);
    } catch {
      /* Invalid contributions confer no favorable evidence. */
    }
  }
  const active: Partial<Record<ExecutorId, number>> = {};
  const capacities: Partial<Record<ExecutorId, CapacitySnapshot>> = {};
  for (const executor of ['claude', 'codex'] as const) {
    const slots = readExecutorSlots(executor);
    const runtimeSessions = new Set(slots.sessions);
    const observedSessions = new Set(current.flatMap((o) => o.sessions[executor]));
    active[executor] =
      slots.count + [...observedSessions].filter((s) => !runtimeSessions.has(s)).length;
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
                live.kind === w.kind &&
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
    machinePolicy: { quotaThresholds: operator.quotaThresholds ?? {}, maxConcurrent },
    active,
    coverage: {
      scope: 'runtime_slots_and_observed_sessions',
      offices: current.map((o) => o.coverage),
      unobservedInteractiveSessions: 'not_counted',
    },
    capacities,
    nowS,
  };
}

export interface QuotaArgs {
  executor: ExecutorId;
  role: string;
  json: boolean;
}
export function parseQuotaArgs(argv: string[]): QuotaArgs {
  if (argv[0] !== 'check')
    throw new Error(
      'Usage: pixel-agents quota check --executor claude|codex --role <role> [--json]',
    );
  const values: Record<string, string> = {};
  let json = false;
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--json' && !json) {
      json = true;
      continue;
    }
    if (
      !['--executor', '--role'].includes(key) ||
      values[key] ||
      !argv[i + 1] ||
      argv[i + 1].startsWith('--')
    )
      throw new Error('Invalid quota check arguments');
    values[key] = argv[++i];
  }
  if (!['claude', 'codex'].includes(values['--executor']) || !values['--role'])
    throw new Error('Executor and role are required');
  return { executor: values['--executor'] as ExecutorId, role: values['--role'], json };
}
export function runQuotaCheck(args: QuotaArgs, cwd = process.cwd(), log = console.log): number {
  const config = loadProjectConfig(cwd);
  if (!config) throw new Error('quota check requires a Project');
  const snapshot = readSelectionSnapshot(config.operator);
  const decision = snapshot.allowedExecutors.includes(args.executor)
    ? quotaGate(
        args.executor,
        snapshot.machinePolicy,
        snapshot.capacities[args.executor],
        snapshot.active[args.executor] ?? NaN,
        snapshot.nowS,
      )
    : {
        status: 'wait',
        resetsAt: null,
        reason: `${args.executor}: executor not allowed by Operator config`,
      };
  log(
    args.json
      ? JSON.stringify({ executor: args.executor, role: args.role, ...decision })
      : `${decision.status}: ${decision.reason}`,
  );
  return decision.status === 'wait' ? 3 : 0;
}
