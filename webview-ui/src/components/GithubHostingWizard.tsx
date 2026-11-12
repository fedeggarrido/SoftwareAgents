import { useEffect, useId, useReducer, useRef, useSyncExternalStore } from 'react';

import {
  GITHUB_REPOSITORY_NAME_MAX_LENGTH,
  githubHostingErrorText,
  validGithubName,
} from '../../../core/src/githubHosting.js';
import type { ClientMessage } from '../../../core/src/messages.js';
import { GITHUB_HOSTING_REQUEST_TIMEOUT_MS } from '../constants.js';
import { officeAccessView, useOfficeAccess } from '../office/accessStore.js';
import { githubWizardReducer, initialGithubWizard } from '../office/githubHostingWizard.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { StatusChip } from './StatusChip.js';
import { Button } from './ui/Button.js';

const subscribe = (listener: () => void) => transport.onStateChange(listener);
const connectionState = () => transport.state;

export function GithubHostingWizard({ projectId }: { projectId: string }) {
  const formId = useId();
  const [state, dispatch] = useReducer(githubWizardReducer, undefined, initialGithubWizard);
  const pending = useRef<string | null>(null);
  const sequence = useRef(0);
  const requestId = () => `github-hosting-${Date.now()}-${++sequence.current}`;
  const access = officeAccessView(useOfficeAccess(), !isBrowserRuntime);
  const connection = useSyncExternalStore(subscribe, connectionState, connectionState);
  const blocked = access.pending || access.blocked || connection !== 'connected';
  useEffect(
    () =>
      transport.onMessage((message) => {
        if (
          (message.type === 'githubHostingOptions' || message.type === 'githubHostingResult') &&
          message.projectId === projectId &&
          message.requestId === pending.current
        ) {
          pending.current = null;
          dispatch({ type: 'reply', message });
        }
      }),
    [projectId],
  );
  useEffect(() => {
    if (!state.pending) return;
    const lost = () => {
      pending.current = null;
      dispatch({ type: 'lost' });
    };
    if (blocked) {
      lost();
      return;
    }
    const timer = window.setTimeout(lost, GITHUB_HOSTING_REQUEST_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [state.pending, blocked]);
  const send = (
    message: Extract<ClientMessage, { type: 'requestGithubHosting' | 'confirmGithubHosting' }>,
  ) => {
    if (blocked || pending.current) return;
    pending.current = message.requestId;
    dispatch({
      type: message.type === 'requestGithubHosting' ? 'load' : 'publish',
      requestId: message.requestId,
    });
    try {
      transport.send(message);
    } catch {
      pending.current = null;
      dispatch({ type: 'lost' });
    }
  };
  const load = () => send({ type: 'requestGithubHosting', projectId, requestId: requestId() });
  return (
    <section className="github-hosting" aria-label="Alojamiento en GitHub">
      <h3>Alojamiento en GitHub</h3>
      {blocked && (
        <p role="status">
          {access.pending || access.blocked
            ? access.explanation
            : 'Reconecta la oficina para continuar.'}
        </p>
      )}
      {state.step === 'idle' && (
        <Button disabled={blocked} onClick={load}>
          Configurar GitHub
        </Button>
      )}
      {state.pending && (
        <div role="status">
          <StatusChip state="RUNNING" />
          <p>{state.step === 'publishing' ? 'Publicando repositorio…' : 'Comprobando cuenta…'}</p>
        </div>
      )}
      {(state.step === 'configure' || state.step === 'confirm') && state.options && (
        <>
          <p>
            {state.options.operation === 'push' ? 'Cuenta conectada' : 'Se creará en la cuenta'}{' '}
            {state.options.login}
          </p>
          {state.step === 'configure' ? (
            <fieldset disabled={blocked}>
              <label htmlFor={`${formId}-name`}>Nombre del repositorio</label>
              <input
                id={`${formId}-name`}
                maxLength={GITHUB_REPOSITORY_NAME_MAX_LENGTH}
                value={state.draft.name}
                disabled={state.options.operation === 'push'}
                onChange={(event) =>
                  dispatch({ type: 'edit', draft: { name: event.target.value } })
                }
              />
              <label htmlFor={`${formId}-owner`}>Propietario</label>
              <select
                id={`${formId}-owner`}
                value={state.draft.owner}
                disabled={state.options.operation === 'push'}
                onChange={(event) =>
                  dispatch({ type: 'edit', draft: { owner: event.target.value } })
                }
              >
                {state.options.owners.map((owner) => (
                  <option key={owner} value={owner}>
                    {owner}
                  </option>
                ))}
              </select>
              <label htmlFor={`${formId}-visibility`}>Visibilidad</label>
              <select
                id={`${formId}-visibility`}
                value={state.draft.visibility}
                disabled={state.options.operation === 'push'}
                onChange={(event) =>
                  dispatch({
                    type: 'edit',
                    draft: { visibility: event.target.value === 'public' ? 'public' : 'private' },
                  })
                }
              >
                <option value="private">Privado</option>
                <option value="public">Público</option>
              </select>
              <Button
                disabled={!validGithubName(state.draft.name)}
                onClick={() => dispatch({ type: 'review' })}
              >
                {state.options.operation === 'push' ? 'Revisar envío' : 'Revisar creación'}
              </Button>
            </fieldset>
          ) : (
            <>
              <p>
                Repositorio {state.draft.owner}/{state.draft.name} ·{' '}
                {state.draft.visibility === 'private' ? 'Privado' : 'Público'}
              </p>
              <p>
                {state.options.operation === 'push'
                  ? 'El repositorio ya está creado. Se enviarán los commits locales pendientes.'
                  : 'Se creará el repositorio en GitHub y se enviará el historial de este proyecto. Si falta el primer commit, se creará con el archivo de proyecto y tu identidad de Git.'}
              </p>
              <Button
                disabled={blocked}
                onClick={() => {
                  const confirmationId = state.options?.confirmationId;
                  if (confirmationId)
                    send({
                      type: 'confirmGithubHosting',
                      projectId,
                      requestId: requestId(),
                      confirmationId,
                      ...state.draft,
                    });
                }}
              >
                {state.options.operation === 'push'
                  ? 'Confirmar envío'
                  : 'Confirmar y crear repositorio'}
              </Button>
              <Button disabled={blocked} onClick={() => dispatch({ type: 'back' })}>
                Anterior
              </Button>
            </>
          )}
        </>
      )}
      {state.error && (
        <div role="alert">
          <StatusChip state="BLOCKED" />
          <p>{githubHostingErrorText(state.error)}</p>
        </div>
      )}
      {state.step === 'uncertain' && (
        <p role="status">
          Se perdió la respuesta. Comprueba el estado antes de confirmar otro intento.
        </p>
      )}
      {(state.step === 'failed' || state.step === 'uncertain') && (
        <Button disabled={blocked} onClick={load}>
          Reintentar
        </Button>
      )}
      {state.step === 'published' && (
        <div role="status">
          <StatusChip state="DONE" />
          <p>Repositorio publicado en GitHub.</p>
        </div>
      )}
    </section>
  );
}
