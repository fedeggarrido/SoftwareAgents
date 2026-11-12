import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stripVTControlCharacters } from 'node:util';

import { IDEA_QUESTIONS } from '../../../core/src/ideaInterview.js';
import type { IdeaAnswer } from '../../../core/src/messages.js';
import { CliUsageError } from '../cliErrors.js';
import { readIdeas, submitIdea } from '../featureIdeas.js';
import { confirmHumanIngress, featureIngressActor } from '../featureIngress.js';
import { IdeaDocumentFailure, readIdeaDocument } from '../ideaDocument.js';

export const FEATURE_IDEA_USAGE =
  'pixel-agents feature idea --from <archivo.pdf|md|txt> [--confirm]';

/** Same authenticated human ingress, review, interview and storage as Nueva idea. */
export async function runFeatureIdeaCommand(
  argv: string[],
  cwd: string,
  log: (text: string) => void,
): Promise<void> {
  if (featureIngressActor() !== 'human')
    throw new CliUsageError('Nueva idea requiere al operador humano.');
  const args = await confirmHumanIngress(argv);
  if (args.length !== 3 || args[0] !== 'idea' || args[1] !== '--from' || !args[2])
    throw new CliUsageError(FEATURE_IDEA_USAGE);
  const snapshot = readIdeas('cli-idea', true, cwd);
  if (!snapshot.canSubmit || !snapshot.projectId)
    throw new CliUsageError('El proyecto no está preparado. Abre Nueva idea en la oficina.');
  const extracted = await readIdeaDocument(path.resolve(cwd, args[2])).catch((error: unknown) => {
    if (error instanceof IdeaDocumentFailure) throw new CliUsageError(error.message);
    throw error;
  });
  log(stripVTControlCharacters(extracted));
  log('Revisa el texto antes de guardar. Puedes editarlo y responder la entrevista.');
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new CliUsageError('Abre una terminal interactiva para revisar y guardar la idea.');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const action = await prompt.question('Pulsa Intro para conservar el texto o escribe editar. ');
    let text = extracted;
    if (action.trim().toLowerCase() === 'editar') {
      log('Escribe el texto completo. Termina con una línea que contenga solo /fin.');
      const lines: string[] = [];
      let line: string;
      while ((line = await prompt.question('')) !== '/fin') lines.push(line);
      text = lines.join('\n');
    } else if (action.trim()) {
      log('Idea cancelada.');
      return;
    }
    const answers: IdeaAnswer[] = [];
    for (const question of IDEA_QUESTIONS) {
      const response = await prompt.question(`${question.label} (Intro para «Decide tú»). `);
      answers.push({
        questionId: question.id,
        choice: response.trim() ? 'answer' : 'decide',
        text: response.trim() ? response : '',
      });
    }
    log(stripVTControlCharacters(text));
    for (const answer of answers) {
      const question = IDEA_QUESTIONS.find((entry) => entry.id === answer.questionId)!;
      log(
        `${question.label}\n${answer.choice === 'decide' ? 'Decide tú' : stripVTControlCharacters(answer.text)}`,
      );
    }
    if ((await prompt.question('¿Guardar idea? [s/N] ')).trim().toLowerCase() !== 's') {
      log('Idea cancelada.');
      return;
    }
    const result = submitIdea(
      { requestId: 'cli-idea', projectId: snapshot.projectId, text, answers },
      true,
      cwd,
    );
    if (result.status !== 'saved' || !result.idea)
      throw new CliUsageError(
        result.errorCode === 'too_large'
          ? 'La idea y la entrevista superan el límite de 1 MiB. Reduce el texto antes de guardar.'
          : 'No se pudo guardar la idea. Consulta las ideas pendientes en la oficina.',
      );
    log(`Idea guardada ${result.idea.key}`);
    log(result.idea.command);
    if (result.errorCode === 'audit_failed')
      log('La idea está guardada, pero falta confirmar su auditoría. No la envíes otra vez.');
  } finally {
    prompt.close();
  }
}
