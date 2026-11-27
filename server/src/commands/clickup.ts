import { CliUsageError } from '../cliErrors.js';
import { featureIngressActor } from '../featureIngress.js';
import type { ClickUpClient } from '../integrations/clickup/client.js';
import type { MirrorOutcome } from '../integrations/clickup/mirror.js';
import { ClickUpMirrorUnavailable, syncClickUp } from '../integrations/clickup/sync.js';

const USAGE = 'Usage: pixel-agents clickup sync [--dry-run]';

const LINE: Record<MirrorOutcome['result'], string> = {
  in_sync: 'al día',
  unmapped: 'sin columna en ClickUp (cancelada)',
  unmatched: 'sin tarea enlazada en ClickUp',
  corrected: 'estado corregido',
  would_correct: 'se corregiría el estado',
  denied: 'escritura denegada por la política',
  pr_commented: 'comentario con la PR publicado',
  would_comment: 'se publicaría el comentario con la PR',
};

function describe(outcome: MirrorOutcome): string {
  const change = 'from' in outcome ? ` (${outcome.from} → ${outcome.to})` : '';
  return `${outcome.key}: ${LINE[outcome.result]}${change}`;
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
