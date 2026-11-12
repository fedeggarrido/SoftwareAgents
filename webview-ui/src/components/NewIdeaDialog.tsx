import { useEffect, useState } from 'react';

import { ideaDocumentErrorText } from '../../../core/src/ideaDocument.js';
import { IDEA_ASSUMPTION_TEXT, IDEA_QUESTIONS } from '../../../core/src/ideaInterview.js';
import type { IdeaAnswer, IdeaAnswerChoice } from '../../../core/src/messages.js';
import {
  OFFICE_ACCESS_INSTRUCTIONS,
  OFFICE_MANAGED_EXPLANATION,
  OFFICE_READ_ONLY_LABEL,
} from '../../../core/src/officeAccess.js';
import {
  PROJECT_PREPARATION_COMMIT_NOTICE,
  PROJECT_PREPARATION_EXPLANATION,
  projectPreparationErrorText,
} from '../../../core/src/projectPreparation.js';
import { IDEA_TEXTAREA_ROWS } from '../constants.js';
import { officeAccessView, useOfficeAccess } from '../office/accessStore.js';
import { sendIdeaDocument } from '../office/ideaDocument.js';
import {
  getIdeasStore,
  ideaDialogState,
  ideaErrorText,
  requestIdeas,
  sendIdea,
  sendProjectPreparation,
  setIdeasStore,
} from '../office/ideasStore.js';
import { useIdeasConnection } from '../office/useIdeasConnection.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { IdeaCommand } from './IdeaCommand.js';
import { IdeaNextSteps } from './IdeaNextSteps.js';
import { OfficeRecoveryActions } from './OfficeRecoveryActions.js';
import { StatusChip } from './StatusChip.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

export function NewIdeaDialog({
  onClose,
  checkoutName,
}: {
  onClose: () => void;
  checkoutName?: string;
}) {
  const [text, setText] = useState('');
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<
    Record<string, { text: string; choice: IdeaAnswerChoice | null }>
  >({});
  const [confirmDiscard, setConfirmDiscard] = useState<'close' | 'consult' | null>(null);
  const [projectDraft, setProjectDraft] = useState({ id: '', name: '' });
  const [draftProjectId, setDraftProjectId] = useState<string | null>(() => {
    const snapshot = getIdeasStore().snapshot;
    return snapshot?.projectId ?? snapshot?.preparation?.id ?? null;
  });
  const [copyFeedback, setCopyFeedback] = useState('');
  useEffect(() => {
    // A new dialog can compose another idea, but never replay an uncertain submission.
    setIdeasStore({ ...getIdeasStore(), result: null, document: undefined });
    return () => setIdeasStore({ ...getIdeasStore(), document: undefined });
  }, []);
  const { store, connection } = useIdeasConnection(true);
  const currentProjectId = store.snapshot?.projectId ?? store.snapshot?.preparation?.id ?? null;
  const hasDraft =
    !!text.length || Object.values(answers).some((entry) => entry.text.length || entry.choice);
  useEffect(() => {
    if ((!draftProjectId || !hasDraft) && currentProjectId) setDraftProjectId(currentProjectId);
  }, [draftProjectId, currentProjectId, hasDraft]);
  const projectMismatch =
    !!draftProjectId && !!currentProjectId && draftProjectId !== currentProjectId;
  const access = officeAccessView(useOfficeAccess(), !isBrowserRuntime);
  const permissionBlocked =
    !access.pending &&
    (access.blocked ||
      store.snapshot?.errorCode === 'denied' ||
      store.snapshot?.preparationError === 'denied');
  const preparation = store.snapshot?.preparation;
  useEffect(() => {
    if (preparation)
      setProjectDraft((draft) =>
        draft.id === preparation.id ? draft : { id: preparation.id, name: preparation.name },
      );
  }, [preparation]);
  const projectName = projectDraft.name;
  const state = ideaDialogState(store, connection === 'connected');
  const finishClose = (consult = false) => {
    if (consult) {
      setIdeasStore({ ...getIdeasStore(), uncertain: false });
      requestIdeas(transport);
    }
    onClose();
  };
  const close = (consult = false) => {
    if (getIdeasStore().pending || getIdeasStore().preparationPending) return;
    if (
      state !== 'saved' &&
      (text.length || Object.values(answers).some((answer) => answer.text.length || answer.choice))
    )
      setConfirmDiscard(consult ? 'consult' : 'close');
    else finishClose(consult);
  };
  const documentLoading =
    store.document?.phase === 'reading' || store.document?.phase === 'extracting';
  const editable = state !== 'saving' && state !== 'saved' && !documentLoading;
  useEffect(() => {
    const document = store.document;
    if (document?.phase !== 'ready') return;
    if (
      !projectMismatch &&
      document.result.projectId === currentProjectId &&
      document.result.text !== null
    )
      setText(document.result.text);
    setIdeasStore({ ...getIdeasStore(), document: undefined });
  }, [store.document, currentProjectId, projectMismatch]);
  const canSave =
    !projectMismatch &&
    !!draftProjectId &&
    !access.pending &&
    !access.blocked &&
    (state === 'editing' || state === 'error');
  const question = IDEA_QUESTIONS[step - 1];
  const answer = question ? answers[question.id] : undefined;
  const reviewing = step === IDEA_QUESTIONS.length + 1;
  const complete = IDEA_QUESTIONS.every((entry) => {
    const value = answers[entry.id];
    return value?.choice === 'decide' || (value?.choice === 'answer' && !!value.text.trim());
  });
  const canContinue =
    step === 0
      ? !!text.trim()
      : answer?.choice === 'decide' || (answer?.choice === 'answer' && !!answer.text.trim());
  const updateAnswer = (choice: IdeaAnswerChoice, value = answer?.text ?? '') => {
    if (question) setAnswers({ ...answers, [question.id]: { choice, text: value } });
  };
  const save = () => {
    if (
      !canSave ||
      getIdeasStore().snapshot?.projectId !== draftProjectId ||
      !text.trim() ||
      !complete
    )
      return;
    const submission: IdeaAnswer[] = IDEA_QUESTIONS.map((entry) => ({
      questionId: entry.id,
      choice: answers[entry.id].choice!,
      text: answers[entry.id].choice === 'decide' ? '' : answers[entry.id].text,
    }));
    sendIdea(text, submission, transport);
  };
  if (permissionBlocked && !projectMismatch) {
    return (
      <Modal isOpen onClose={() => close()} title="Nueva idea" className="idea-dialog">
        <div role="region" aria-label="Nueva idea" className="p-10 flex flex-col gap-8">
          <p role="status">
            {store.snapshot?.preparationError === 'denied'
              ? OFFICE_MANAGED_EXPLANATION
              : store.snapshot?.errorCode === 'denied'
                ? `${OFFICE_READ_ONLY_LABEL}. ${OFFICE_ACCESS_INSTRUCTIONS}`
                : access.explanation}
          </p>
          <OfficeRecoveryActions />
          {confirmDiscard && (
            <div role="alertdialog" aria-label="Descartar borrador" className="flex flex-col gap-8">
              <p>El borrador tiene contenido sin guardar. ¿Quieres descartarlo?</p>
              <Button onClick={() => setConfirmDiscard(null)}>Conservar borrador</Button>
              <Button onClick={() => finishClose()}>Descartar borrador</Button>
            </div>
          )}
          <Button onClick={() => close()}>Cerrar</Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal isOpen onClose={() => close()} title="Nueva idea" className="idea-dialog">
      <div role="region" aria-label="Nueva idea" className="p-10 flex flex-col gap-8">
        <p>
          Describe lo que necesitas. Guardar deja un borrador pendiente; no inicia ningún trabajo.
        </p>
        {projectMismatch && (
          <section role="alert" className="flex flex-col gap-8">
            <p>Este borrador era para otro proyecto ({draftProjectId})</p>
            <p className="whitespace-pre-wrap">{text}</p>
            {IDEA_QUESTIONS.map(
              (entry) =>
                answers[entry.id] && (
                  <p key={entry.id}>
                    {entry.label}:{' '}
                    {answers[entry.id].choice === 'decide'
                      ? IDEA_ASSUMPTION_TEXT
                      : answers[entry.id].text}
                  </p>
                ),
            )}
            <Button
              onClick={() => {
                setText('');
                setAnswers({});
                setStep(0);
                setDraftProjectId(currentProjectId);
                setCopyFeedback('');
              }}
            >
              Descartar
            </Button>
            <Button
              onClick={() => {
                const content = [
                  text,
                  ...IDEA_QUESTIONS.filter((entry) => answers[entry.id]).map(
                    (entry) =>
                      `${entry.label}: ${answers[entry.id].choice === 'decide' ? IDEA_ASSUMPTION_TEXT : answers[entry.id].text}`,
                  ),
                ].join('\n\n');
                void Promise.resolve()
                  .then(() => navigator.clipboard.writeText(content))
                  .then(
                    () => setCopyFeedback('Texto copiado.'),
                    () =>
                      setCopyFeedback(
                        'No se pudo copiar. Selecciona el texto y cópialo manualmente.',
                      ),
                  );
              }}
            >
              Copiar texto
            </Button>
            <p role="status">{copyFeedback}</p>
          </section>
        )}
        {preparation && (
          <section aria-label="Preparar proyecto" className="flex flex-col gap-8">
            <p>{PROJECT_PREPARATION_EXPLANATION}</p>
            <label htmlFor="project-name">Nombre del proyecto</label>
            <input
              id="project-name"
              value={projectName}
              onChange={(event) => setProjectDraft({ ...projectDraft, name: event.target.value })}
              disabled={access.pending || !!store.preparationPending || connection !== 'connected'}
              className="bg-bg-dark text-text border-2 border-border p-8"
            />
            <p>
              Rama principal detectada <strong>{preparation.defaultBranch}</strong>
            </p>
            <p>
              Se creará <code>{preparation.configPath}</code> y la carpeta{' '}
              <code>{preparation.brainPath}</code>.
            </p>
            <dl>
              <dt>Identificador</dt>
              <dd>{preparation.id}</dd>
              <dt>Nombre</dt>
              <dd>{projectName}</dd>
              <dt>Remoto</dt>
              <dd>{preparation.remote}</dd>
            </dl>
            <p>{PROJECT_PREPARATION_COMMIT_NOTICE}</p>
            <Button
              disabled={
                access.pending ||
                projectMismatch ||
                !projectName.trim() ||
                !!store.preparationPending ||
                connection !== 'connected'
              }
              onClick={() => sendProjectPreparation(projectName, transport)}
            >
              {store.preparationPending ? 'Preparando…' : 'Preparar proyecto'}
            </Button>
          </section>
        )}
        {!access.pending && store.snapshot?.preparationError && (
          <div role="alert">
            <p>{projectPreparationErrorText(store.snapshot.preparationError)}</p>
            <OfficeRecoveryActions />
          </div>
        )}
        {store.preparationResult?.status === 'created' && (
          <p role="status">Proyecto preparado. {PROJECT_PREPARATION_COMMIT_NOTICE}</p>
        )}
        {!access.pending && store.preparationResult?.errorCode && (
          <div role="alert">
            <p>{projectPreparationErrorText(store.preparationResult.errorCode)}</p>
            <Button onClick={() => requestIdeas(transport)}>Reintentar</Button>
            <OfficeRecoveryActions />
          </div>
        )}
        {confirmDiscard ? (
          <div role="alertdialog" aria-label="Descartar borrador" className="flex flex-col gap-8">
            <p>El borrador tiene contenido sin guardar. ¿Quieres descartarlo?</p>
            <Button onClick={() => setConfirmDiscard(null)}>Seguir editando</Button>
            <Button onClick={() => finishClose(confirmDiscard === 'consult')}>
              Descartar borrador
            </Button>
          </div>
        ) : state === 'saved' && store.result?.idea ? (
          <div className="flex flex-col gap-8">
            <p role="status">
              Idea guardada: <strong>{store.result.idea.key}</strong> · pendiente
            </p>
            <IdeaNextSteps />
            <IdeaCommand
              key={store.result.idea.command}
              command={store.result.idea.command}
              checkoutName={checkoutName}
            />
            {store.result.errorCode && <p role="alert">{ideaErrorText(store.result.errorCode)}</p>}
          </div>
        ) : (
          <>
            <p role="status">
              Paso {step + 1} de {IDEA_QUESTIONS.length + 2}
            </p>
            {step === 0 && (
              <>
                <label htmlFor="new-idea-document">
                  Adjuntar documento (PDF, MD o TXT, hasta 5 MB)
                </label>
                <input
                  id="new-idea-document"
                  type="file"
                  accept=".pdf,.md,.txt"
                  className="idea-document-input"
                  disabled={!canSave || documentLoading}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file && canSave) void sendIdeaDocument(file, transport);
                  }}
                />
                {documentLoading && <p role="status">Extrayendo texto del documento…</p>}
                {store.document?.phase === 'error' && (
                  <div role="alert">
                    <StatusChip state="FAILED" />
                    <p>{ideaDocumentErrorText(store.document.errorCode)}</p>
                  </div>
                )}
                <p>
                  Revisa y edita el texto antes de guardar. La idea y la entrevista admiten hasta 1
                  MiB.
                </p>
                <label htmlFor="new-idea-text">Tu idea</label>
                <textarea
                  id="new-idea-text"
                  rows={IDEA_TEXTAREA_ROWS}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  disabled={!editable}
                  className="bg-bg-dark text-text border-2 border-border p-8 w-full"
                />
              </>
            )}
            {question && (
              <fieldset disabled={!editable} className="min-w-0 flex flex-col gap-8">
                <legend>{question.label}</legend>
                <p id="idea-question-helper">{question.helper}</p>
                <label>
                  <input
                    type="radio"
                    name="idea-choice"
                    value="answer"
                    checked={answer?.choice === 'answer'}
                    onChange={() => updateAnswer('answer')}
                  />{' '}
                  Responder
                </label>
                <label htmlFor="idea-answer">Tu respuesta</label>
                <textarea
                  id="idea-answer"
                  rows={IDEA_TEXTAREA_ROWS}
                  aria-describedby="idea-question-helper"
                  value={answer?.text ?? ''}
                  disabled={!editable || answer?.choice === 'decide'}
                  onChange={(event) => updateAnswer('answer', event.target.value)}
                  className="bg-bg-dark text-text border-2 border-border p-8 w-full"
                />
                <label>
                  <input
                    type="radio"
                    name="idea-choice"
                    value="decide"
                    checked={answer?.choice === 'decide'}
                    onChange={() => updateAnswer('decide')}
                  />{' '}
                  Decide tú
                </label>
                {answer?.choice === 'decide' && <p>{IDEA_ASSUMPTION_TEXT}</p>}
                {!answer?.text.trim() && answer?.choice !== 'decide' && (
                  <p>Escribe una respuesta o elige «Decide tú» para continuar.</p>
                )}
              </fieldset>
            )}
            {reviewing && (
              <section className="idea-review" aria-label="Revisar entrevista">
                <h3>Idea</h3>
                <p>{text}</p>
                {IDEA_QUESTIONS.map((entry) => (
                  <div key={entry.id}>
                    <h3>{entry.label}</h3>
                    <p>
                      {answers[entry.id]?.choice === 'decide'
                        ? IDEA_ASSUMPTION_TEXT
                        : answers[entry.id]?.text}
                    </p>
                  </div>
                ))}
                <p>
                  Las preguntas adaptativas llegarán mediante Requirements (openQuestions) al panel
                  de Decisiones cuando inicies el flujo.
                </p>
              </section>
            )}
            <div role={state === 'error' || state === 'uncertain' ? 'alert' : 'status'}>
              {access.pending && connection === 'connected' && <p>{access.explanation}</p>}
              {!access.pending && state === 'loading' && 'Comprobando el Project…'}
              {!access.pending &&
                state === 'disabled' &&
                !preparation &&
                !store.snapshot?.preparationError &&
                ideaErrorText(store.snapshot?.errorCode)}
              {!access.pending && state === 'error' && ideaErrorText(store.result?.errorCode)}

              {state === 'saving' && 'Guardando…'}
              {state === 'uncertain' &&
                'No se pudo confirmar el guardado. Consulta las ideas pendientes antes de enviar otra; el envío no se repetirá automáticamente.'}
            </div>
            {step > 0 && (
              <Button disabled={!editable} onClick={() => setStep(step - 1)}>
                Anterior
              </Button>
            )}
            {reviewing ? (
              <Button disabled={!canSave || !text.trim() || !complete} onClick={save}>
                {state === 'saving' ? 'Guardando…' : 'Guardar idea'}
              </Button>
            ) : (
              <Button disabled={!editable || !canContinue} onClick={() => setStep(step + 1)}>
                Siguiente
              </Button>
            )}
            {state === 'uncertain' && (
              <Button onClick={() => close(true)}>Consultar ideas pendientes</Button>
            )}
            {state === 'disabled' && (
              <Button onClick={() => requestIdeas(transport)}>Reintentar lectura de ideas</Button>
            )}
          </>
        )}
        <Button disabled={state === 'saving' || !!store.preparationPending} onClick={() => close()}>
          Cerrar
        </Button>
      </div>
    </Modal>
  );
}
