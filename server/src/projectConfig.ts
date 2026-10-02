import * as fs from 'fs';
import { parseDocument } from 'yaml';

import * as projectSchema from '../../core/schemas/project.schema.json';
import type { ProjectConfig, ProjectManifest } from '../../core/src/project.js';
import { readConfig } from './configPersistence.js';
import { resolveInside } from './pathGuard.js';
import { compileSchema, SchemaValidationError, validateSchema } from './schemaValidation.js';

const validateProject = compileSchema<ProjectManifest>(projectSchema);

function resolveProjectPath(root: string, value: string, field: string): string {
  try {
    return resolveInside(root, value);
  } catch (error) {
    throw new SchemaValidationError([`${field}: ${(error as Error).message}`]);
  }
}

/** Missing manifest preserves legacy startup; invalid content fails with field diagnostics.
 * Reads only: neither repository content nor this loader writes Operator config.
 * companyAutopilot remains workspace-keyed for legacy companyControl; its migration
 * requires explicit operator action when that consumer adopts Project (SA-010/011).
 */
export function loadProjectConfig(repoRoot: string): ProjectConfig | null {
  const file = resolveProjectPath(repoRoot, '.softwareagents/project.yaml', '/project.yaml');
  let source: string;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) {
    throw new SchemaValidationError(
      document.errors.map((error) => `/project.yaml: ${error.message}`),
    );
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    throw new SchemaValidationError([`/project.yaml: ${(error as Error).message}`]);
  }
  const project = validateSchema(validateProject, value);
  const paths = {
    brain: resolveProjectPath(repoRoot, project.brain.path, '/brain/path'),
    ...(project.legacy
      ? { boardFile: resolveProjectPath(repoRoot, project.legacy.boardFile, '/legacy/boardFile') }
      : {}),
  };
  const projects = readConfig().projects;
  return {
    project,
    repoRoot: fs.realpathSync.native(repoRoot),
    paths,
    operator: projects[project.id] ?? { autonomyLevel: 'A0', allowedExecutors: [] },
  };
}
