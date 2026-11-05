import { createInterface } from 'node:readline/promises';

import {
  PROJECT_PREPARATION_COMMIT_NOTICE,
  projectPreparationErrorText,
} from '../../../core/src/projectPreparation.js';
import { CliUsageError } from '../cliErrors.js';
import { confirmHumanIngress, featureIngressActor, OPERATOR_TOKEN_ENV } from '../featureIngress.js';
import {
  inspectProjectPreparation,
  prepareProject,
  projectPreparationError,
} from '../projectPreparation.js';

export const PROJECT_INIT_HELP = 'pixel-agents project init [--name <name>] [--yes]';

async function confirmCreation(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new CliUsageError(
      'La preparación requiere confirmación interactiva. Usa --yes para confirmar la creación.',
    );
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question('¿Preparar el proyecto? [s/N] ');
    return ['s', 'si', 'sí', 'y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    prompt.close();
  }
}

export async function runProjectCommand(argv: string[]): Promise<void> {
  if (argv.includes('--help')) {
    console.log(PROJECT_INIT_HELP);
    return;
  }
  if (argv[0] !== 'init') throw new CliUsageError(PROJECT_INIT_HELP);
  let name: string | undefined;
  let yes = false;
  for (let index = 1; index < argv.length; index++) {
    if (argv[index] === '--yes' && !yes) yes = true;
    else if (
      argv[index] === '--name' &&
      name === undefined &&
      argv[index + 1] &&
      !argv[index + 1].startsWith('--')
    )
      name = argv[++index];
    else throw new CliUsageError(PROJECT_INIT_HELP);
  }
  if (featureIngressActor() !== 'human')
    throw new CliUsageError(projectPreparationErrorText('denied'));
  let proposal;
  try {
    proposal = inspectProjectPreparation(process.cwd(), name).proposal;
  } catch (error) {
    throw new CliUsageError(projectPreparationErrorText(projectPreparationError(error)));
  }
  console.log(
    `Proyecto ${JSON.stringify(proposal.name)}\nId ${proposal.id}\nRama principal ${JSON.stringify(proposal.defaultBranch)}\nRemoto ${JSON.stringify(proposal.remote)}\nSe creará ${proposal.configPath} y la carpeta ${proposal.brainPath}.\n${PROJECT_PREPARATION_COMMIT_NOTICE}`,
  );
  if (!yes && !(await confirmCreation())) {
    console.log('Preparación cancelada.');
    return;
  }
  // --yes confirms file creation. The existing live-server capability still authenticates it.
  await confirmHumanIngress(process.env[OPERATOR_TOKEN_ENV] ? [] : ['--confirm']);
  const result = prepareProject(process.cwd(), name, true);
  if (result.status !== 'created')
    throw new CliUsageError(projectPreparationErrorText(result.errorCode ?? 'unavailable'));
  console.log(`Proyecto preparado. ${PROJECT_PREPARATION_COMMIT_NOTICE}`);
  if (result.errorCode) console.warn(projectPreparationErrorText(result.errorCode));
}
