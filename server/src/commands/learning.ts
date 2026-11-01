import { CliUsageError } from '../cliErrors.js';
import { confirmHumanIngress, featureIngressActor } from '../featureIngress.js';
import { decideLearning, learningDecisionKey, learningHash, listLearnings } from '../learnings.js';
import { loadProjectConfig } from '../projectConfig.js';
import { openWorkStore } from '../workstore/SqliteWorkStore.js';

export async function runLearningCommand(argv: string[], cwd = process.cwd(), log = console.log) {
  if (['approve', 'reject'].includes(argv[0])) argv = await confirmHumanIngress(argv);
  const [command, id, flag, reason] = argv;
  // Reading proposals is harmless; only approving or rejecting is a human decision.
  if (command !== 'list' && featureIngressActor() !== 'human')
    throw new CliUsageError('learning approve/reject requires human ingress (SA-003)');
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
    const lesson = decideLearning(config.repoRoot, id, command as 'approve' | 'reject', reason);
    // The durable human record (with the content hash) is what the worker trusts.
    const store = await openWorkStore({
      repositoryPath: config.repoRoot,
      projectId: config.project.id,
    });
    try {
      store.recordHumanDecision({
        key: learningDecisionKey(id),
        // No foreign keys: the origin Task/Execution may have been pruned or re-imported.
        task_key: null,
        execution_key: null,
        question: `learning approval (origin ${lesson.origin.task}/${lesson.origin.execution})`,
        answer: `${command}:${learningHash(lesson)}`,
        actor: 'human',
        decided_at: new Date().toISOString(),
      });
    } finally {
      store.close();
    }
    log(`${id}: ${command}`);
  }
}
