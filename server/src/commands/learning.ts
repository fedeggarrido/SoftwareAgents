import { CliUsageError } from '../cliErrors.js';
import { featureIngressActor } from '../featureIngress.js';
import { decideLearning, listLearnings } from '../learnings.js';
import { loadProjectConfig } from '../projectConfig.js';

export function runLearningCommand(argv: string[], cwd = process.cwd(), log = console.log) {
  const [command, id, flag, reason] = argv;
  if (featureIngressActor() !== 'human')
    throw new CliUsageError('learning requires human ingress (SA-003)');
  if (
    !(command === 'list' && argv.length === 1) &&
    !(
      ['approve', 'reject'].includes(command) &&
      /^[a-f0-9]{24}$/.test(id ?? '') &&
      (argv.length === 2 ||
        (command === 'reject' && argv.length === 4 && flag === '--reason' && reason.trim()))
    )
  )
    throw new CliUsageError(
      'Usage: pixel-agents learning list|approve <id>|reject <id> [--reason <text>]',
    );
  const config = loadProjectConfig(cwd, true);
  if (!config) throw new CliUsageError('learning requires a bound Project');
  if (command === 'list') {
    log(
      JSON.stringify(
        {
          proposed: listLearnings(config.repoRoot, 'proposed'),
          approved: listLearnings(config.repoRoot, 'approved'),
          rejected: listLearnings(config.repoRoot, 'rejected'),
        },
        null,
        2,
      ),
    );
  } else {
    decideLearning(config.repoRoot, id, command as 'approve' | 'reject', reason);
    log(`${id}: ${command}`);
  }
}
