import { AuditLog } from '../auditLog.js';
import { CliUsageError } from '../cliErrors.js';
import { confirmHumanIngress } from '../featureIngress.js';
import { scaffoldHexagonalProject } from '../projectArchitectureTemplate.js';
import { loadProjectConfig } from '../projectConfig.js';
import { chosenStack, stackDecision } from '../projectStack.js';
import { openWorkStore } from '../workstore/SqliteWorkStore.js';

/** Authenticated, explicit opt-in. Reading/answering a Decision never scaffolds code. */
export async function runProjectScaffold(argv: string[]): Promise<void> {
  const args = await confirmHumanIngress(argv);
  if (args.length !== 2 || args[0] !== 'scaffold' || !/^FEAT-\d{3}$/.test(args[1]))
    throw new CliUsageError('pixel-agents project scaffold FEAT-### [--confirm]');
  const config = loadProjectConfig(process.cwd());
  if (!config) throw new CliUsageError('Prepara el proyecto antes de crear la plantilla.');
  const store = await openWorkStore({
    repositoryPath: config.repoRoot,
    projectId: config.project.id,
  });
  try {
    const decision = stackDecision(store, args[1]);
    const stack = decision && chosenStack(decision);
    if (!stack) throw new CliUsageError('La plantilla requiere un stack aceptado por el humano.');
    const audit = new AuditLog();
    const entry = {
      projectId: store.projectId,
      action: 'scaffold_project',
      resourceType: 'project',
      resourceId: store.projectId,
      actorType: 'human' as const,
      actorId: 'operator',
      policyDecision: null,
      riskLevel: 'low' as const,
      taskKey: args[1],
      executionId: null,
    };
    audit.append({ ...entry, outcome: { status: 'pending' } });
    const files = scaffoldHexagonalProject(config.repoRoot, stack.stack.language.text);
    audit.append({ ...entry, outcome: { status: 'created', detail: JSON.stringify(files) } });
    console.log(
      `Plantilla hexagonal: ${files.length} archivos creados. Los archivos existentes se conservan. Revisa y versiona los cambios antes de desarrollar.`,
    );
  } finally {
    store.close();
  }
}
