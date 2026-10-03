import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { CapacitySnapshot } from '../../core/src/capacity.js';
import type { ProjectOperatorConfig } from '../../core/src/project.js';
import { readConfig } from './configPersistence.js';
import type { ExecutorId } from './executors/executor.js';
import type { SelectionSnapshot } from './executorSelection.js';
import { loadProjectConfig } from './projectConfig.js';
import { quotaGate } from './quotaGate.js';
import { compileSchema, validateSchema } from './schemaValidation.js';

const MAX_OBSERVATION_AGE_S = 60;
interface MachineObservation {
  observedAt: number;
  active: Partial<Record<ExecutorId, number>>;
  capacities?: Partial<Record<ExecutorId, CapacitySnapshot>>;
}
const validateObservation = compileSchema<MachineObservation>({
  type: 'object',
  additionalProperties: false,
  required: ['observedAt', 'active'],
  properties: {
    observedAt: { type: 'number' },
    active: {
      type: 'object',
      additionalProperties: false,
      properties: {
        claude: { type: 'integer', minimum: 0 },
        codex: { type: 'integer', minimum: 0 },
      },
    },
    capacities: {
      type: 'object',
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
  },
});

/** Operator-supplied machine observation, never inferred from one project's registry.
 * Missing/stale counts fail closed. This is observation, not a reservation (SA-037).
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
  let observation: MachineObservation | undefined;
  try {
    observation = validateSchema(
      validateObservation,
      JSON.parse(
        fs.readFileSync(path.join(os.homedir(), '.pixel-agents', 'machine-capacity.json'), 'utf8'),
      ),
    );
    if (observation.observedAt > nowS || nowS - observation.observedAt > MAX_OBSERVATION_AGE_S)
      observation = undefined;
  } catch {
    /* No trusted machine count means wait, never zero. */
  }
  const capacities = observation?.capacities ?? {};
  for (const executor of ['claude', 'codex'] as const) {
    const observedAt = capacities[executor]?.observedAt;
    if (
      observedAt === null ||
      observedAt === undefined ||
      observedAt > nowS ||
      nowS - observedAt > MAX_OBSERVATION_AGE_S
    )
      delete capacities[executor];
  }
  return {
    allowedExecutors: operator.allowedExecutors,
    machinePolicy: { quotaThresholds: operator.quotaThresholds ?? {}, maxConcurrent },
    active: observation?.active ?? {},
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
