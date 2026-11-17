import * as fs from 'node:fs';
import * as path from 'node:path';

import { parse } from 'yaml';

import type { DagTask } from '../../core/src/taskDag.js';
import { zonesOverlap } from './changeZones.js';
import { readTaskInput, taskPath } from './commands/taskFiles.js';
import { TASK_CLI_INPUT_BYTES } from './constants.js';
import { evalGit } from './evalTasks.js';
import {
  INTEGRATION_CATALOG_FILE,
  INTEGRATION_SERVICE_PATTERN,
  OUTBOUND_ADAPTER_ZONE,
} from './integrationConstants.js';
import { compileSchema, validateSchema } from './schemaValidation.js';

export interface IntegrationEntry {
  service: string;
  port: string;
  auth: string;
  limits: string;
  owner: string;
}

const text = { type: 'string', minLength: 1, pattern: '\\S' };
const validateCatalog = compileSchema<IntegrationEntry[]>({
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['service', 'port', 'auth', 'limits', 'owner'],
    properties: {
      service: { type: 'string', pattern: INTEGRATION_SERVICE_PATTERN },
      port: text,
      auth: text,
      limits: text,
      owner: text,
    },
  },
});

export function integrationCatalogPath(brain: string): string {
  return path.posix.join(brain.replaceAll('\\', '/'), INTEGRATION_CATALOG_FILE);
}

/** The only additional metadata write granted to the integrations role. */
export function integrationWritablePaths(
  task: Pick<DagTask, 'agentRole'>,
  brain: string,
): string[] {
  return task.agentRole === 'integrations' ? [integrationCatalogPath(brain)] : [];
}

export function parseIntegrationCatalog(source: string): IntegrationEntry[] {
  if (Buffer.byteLength(source) > TASK_CLI_INPUT_BYTES)
    throw new Error('El catálogo supera el límite de tamaño permitido.');
  const catalog = validateSchema(validateCatalog, parse(source));
  if (new Set(catalog.map((entry) => entry.service)).size !== catalog.length)
    throw new Error('El catálogo contiene servicios duplicados.');
  return catalog;
}

/** Read the trusted integration/main branch, never the agent's writable task tree. */
export function integrationCatalogAtRef(
  cwd: string,
  brain: string,
  ref: string,
): IntegrationEntry[] {
  const relative = integrationCatalogPath(brain);
  taskPath(cwd, relative);
  const entry = evalGit(cwd, ['ls-tree', ref, '--', relative]);
  if (!entry) return [];
  if (!/^100(644|755) blob /.test(entry))
    throw new Error('El catálogo debe ser un archivo regular.');
  return parseIntegrationCatalog(evalGit(cwd, ['show', `${ref}:${relative}`]));
}

/** Conservative path policy avoids interpreting natural-language task descriptions. */
export function integrationTaskErrors(task: DagTask, brain: string): string[] {
  const errors: string[] = [];
  if (
    task.type === 'code' &&
    task.changeZones?.some((zone) => zonesOverlap(zone, OUTBOUND_ADAPTER_ZONE)) &&
    task.agentRole !== 'integrations'
  )
    errors.push(`${task.key}: src/adapters/out requiere agentRole integrations`);
  if (task.agentRole === 'integrations') {
    if (task.type !== 'code') errors.push(`${task.key}: integrations requiere type code`);
    if (!task.externalServices?.length)
      errors.push(`${task.key}: integrations requiere externalServices`);
    if (!task.changeZones?.includes(integrationCatalogPath(brain)))
      errors.push(`${task.key}: changeZones debe incluir ${integrationCatalogPath(brain)}`);
  } else if (task.externalServices?.length)
    errors.push(`${task.key}: externalServices requiere agentRole integrations`);
  return errors;
}

export function guardIntegrationCatalog(
  task: DagTask,
  brain: string,
  tree: string,
  base: string,
): void {
  const relative = integrationCatalogPath(brain);
  // Only integrations tasks may change the catalog; any other role (e.g. a doc task whose
  // zone covers a custom brain path) would otherwise register services without a decision.
  if (task.agentRole !== 'integrations') {
    const exists = fs.existsSync(taskPath(tree, relative));
    const known = evalGit(tree, ['ls-tree', base, '--', relative]) !== '';
    const current = exists ? readTaskInput(tree, relative) : null;
    const previous = known ? evalGit(tree, ['show', `${base}:${relative}`]) : null;
    if (current?.trim() !== previous?.trim())
      throw new Error(`Solo una tarea de integraciones puede modificar ${relative}`);
    return;
  }
  if (!fs.existsSync(taskPath(tree, relative)))
    throw new Error(`Falta el catálogo de integraciones ${relative}`);
  const catalog = parseIntegrationCatalog(readTaskInput(tree, relative));
  const previous = integrationCatalogAtRef(tree, brain, base);
  for (const entry of catalog)
    if (
      !previous.some((known) => known.service === entry.service) &&
      !task.externalServices?.includes(entry.service)
    )
      throw new Error(
        `El servicio ${entry.service} requiere declaración y decisión humana antes de ejecutarse.`,
      );
  for (const service of task.externalServices ?? [])
    if (!catalog.some((entry) => entry.service === service))
      throw new Error(`El catálogo debe incluir el servicio ${service}`);
}
