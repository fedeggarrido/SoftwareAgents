import { CliUsageError } from '../cliErrors.js';
import { featureIngressActor } from '../featureIngress.js';
import type { ClickUpClient } from '../integrations/clickup/client.js';
import type { MirrorOutcome } from '../integrations/clickup/mirror.js';
import { ClickUpMirrorUnavailable, syncClickUp } from '../integrations/clickup/sync.js';

const USAGE = 'Usage: pixel-agents clickup sync [--dry-run]';

function describe(outcome: MirrorOutcome): string {
  switch (outcome.result) {
    case 'in_sync':
      return `${outcome.key}: al día`;
    case 'unmapped':
      return `${outcome.key}: sin columna en ClickUp (cancelada)`;
    case 'unmatched':
      return `${outcome.key}: sin tarea enlazada en ClickUp`;
    case 'denied':
      return `${outcome.key}: escritura denegada por la política (${outcome.reason})`;
    case 'failed':
      return `${outcome.key}: falló (${outcome.reason})`;
    case 'mirrored':
    case 'would_mirror': {
      const verb = outcome.result === 'mirrored' ? '' : 'se haría: ';
      const parts = [
        ...(outcome.status ? [`estado ${outcome.status.from} → ${outcome.status.to}`] : []),
        ...(outcome.prComment ? ['comentario con la PR'] : []),
      ];
      return `${outcome.key}: ${verb}${parts.join(' y ')}`;
    }
  }
}

/** SA-053: reflect the work store in ClickUp. Opt-in per Project in the Operator config. */
export async function runClickUpCommand(
  argv: string[],
  cwd = process.cwd(),
  log = console.log,
  client?: ClickUpClient,
): Promise<MirrorOutcome[]> {
  if (argv[0] !== 'sync' || argv.length > 2 || (argv[1] !== undefined && argv[1] !== '--dry-run'))
    throw new CliUsageError(USAGE);
  try {
    const outcomes = await syncClickUp(cwd, {
      actor: featureIngressActor('system'),
      dryRun: argv[1] === '--dry-run',
      client,
    });
    for (const outcome of outcomes) log(describe(outcome));
    if (!outcomes.length) log('No hay tareas que reflejar.');
    return outcomes;
  } catch (error) {
    if (error instanceof ClickUpMirrorUnavailable) throw new CliUsageError(error.message);
    throw error;
  }
}
