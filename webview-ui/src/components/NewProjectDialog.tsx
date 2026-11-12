import { useEffect, useReducer, useRef, useSyncExternalStore } from 'react';

import type { ClientMessage } from '../../../core/src/messages.js';
import { newProjectErrorText, projectHostingText } from '../../../core/src/newProject.js';
import { PROJECT_NAME_MAX_LENGTH, projectSlug } from '../../../core/src/projectNaming.js';
import { NEW_PROJECT_REQUEST_TIMEOUT_MS } from '../constants.js';
import { officeAccessView, useOfficeAccess } from '../office/accessStore.js';
import type { ProjectDraft, WizardOperation } from '../office/newProjectWizard.js';
import {
  canContinueProjectName,
  initialProjectWizard,
  projectWizardReducer,
} from '../office/newProjectWizard.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { GithubHostingWizard } from './GithubHostingWizard.js';
import { StatusChip } from './StatusChip.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

const stepTitles = {
  loading: 'Nombre',
  name: 'Nombre',
  path: 'Ruta local',
  hosting: 'Alojamiento',
  confirm: 'Confirmar proyecto',
  creating: 'Creando proyecto',
  created: 'Proyecto creado',
  github: 'Alojamiento del proyecto',
  uncertain: 'Comprobar creación',
};
const subscribeConnection = (listener: () => void) => transport.onStateChange(listener);
const transportState = () => transport.state;

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [state, dispatch] = useReducer(projectWizardReducer, undefined, initialProjectWizard);
  const access = officeAccessView(useOfficeAccess(), !isBrowserRuntime);
  const connection = useSyncExternalStore(subscribeConnection, transportState, transportState);
  const sequence = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const directories = state.directories;
  const validationPath = state.validation?.path;
  const blocked = access.pending || access.blocked || connection !== 'connected';
  const send = (
    operation: WizardOperation,
    message: Extract<ClientMessage, { requestId: string }>,
  ) => {
    if (blocked || state.pending) return;
    dispatch({ type: 'begin', requestId: message.requestId, operation });
    try {
      transport.send(message);
    } catch {
      dispatch({ type: 'lost' });
    }
  };
  const requestId = () => `new-project-${Date.now()}-${++sequence.current}`;
  useEffect(
    () =>
      transport.onMessage((message) => {
        if (
          message.type === 'newProjectOptions' ||
          message.type === 'projectDirectories' ||
          message.type === 'newProjectValidation' ||
          message.type === 'newProjectResult'
        )
          dispatch({ type: 'reply', message });
      }),
    [],
  );
  useEffect(() => {
    heading.current?.focus();
  }, [state.step]);
  useEffect(() => {
    if (blocked || state.step !== 'loading' || state.pending) return;
    const id = `new-project-options-${Date.now()}-${++sequence.current}`;
    dispatch({ type: 'begin', requestId: id, operation: 'options' });
    try {
      transport.send({ type: 'requestNewProject', requestId: id });
    } catch {
      dispatch({ type: 'lost' });
    }
  }, [blocked, state.step, state.pending]);
  useEffect(() => {
    if (!state.pending) return;
    if (connection !== 'connected') {
      dispatch({ type: 'lost' });
      return;
    }
    const timer = window.setTimeout(
      () => dispatch({ type: 'lost' }),
      NEW_PROJECT_REQUEST_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [state.pending, connection]);
  const browse = (directory: string, purpose: 'browse' | 'save_default' = 'browse') =>
    send(purpose, {
      type: 'browseProjectDirectories',
      requestId: requestId(),
      path: directory,
      purpose,
    });
  const close = () => {
    if (state.step !== 'creating') onClose();
  };
  const disabled = blocked || !!state.pending;
  return (
    <Modal isOpen onClose={close} title="Nuevo proyecto" className="new-project-dialog">
      <div className="new-project-content">
        <h2 ref={heading} tabIndex={-1}>
          {stepTitles[state.step]}
        </h2>
        {blocked && (
          <p role="status">
            {access.blocked || access.pending
              ? access.explanation
              : 'Reconecta la oficina para continuar.'}
          </p>
        )}
        <fieldset disabled={disabled}>
          {state.step === 'name' && (
            <>
              <div className="new-project-proposals" aria-label="Nombres propuestos">
                {state.proposals.map((name) => (
                  <Button key={name} onClick={() => dispatch({ type: 'edit', draft: { name } })}>
                    {name}
                  </Button>
                ))}
              </div>
              <label htmlFor="new-project-name">Nombre del proyecto</label>
              <input
                id="new-project-name"
                value={state.draft.name}
                maxLength={PROJECT_NAME_MAX_LENGTH}
                onChange={(event) =>
                  dispatch({ type: 'edit', draft: { name: event.target.value } })
                }
              />
              <p>
                Nombre de carpeta{' '}
                <strong>{projectSlug(state.draft.name) || 'Escribe un nombre'}</strong>
              </p>
              <Button
                disabled={!canContinueProjectName(state.draft.name)}
                onClick={() => dispatch({ type: 'next' })}
              >
                Siguiente
              </Button>
            </>
          )}
          {state.step === 'path' && (
            <>
              <label htmlFor="new-project-parent">
                {state.draft.folderMode === 'existing' ? 'Carpeta existente' : 'Carpeta principal'}
              </label>
              <input
                id="new-project-parent"
                value={state.draft.parentPath}
                onChange={(event) =>
                  dispatch({
                    type: 'edit',
                    draft: { parentPath: event.target.value, folderMode: 'create' },
                  })
                }
              />
              <div className="new-project-actions">
                <Button onClick={() => browse(state.draft.parentPath)}>Elegir carpeta</Button>
                <Button onClick={() => browse(state.draft.parentPath, 'save_default')}>
                  Guardar como predeterminada
                </Button>
              </div>
              {state.defaultSaved && <p role="status">Carpeta predeterminada guardada.</p>}
              {directories?.path && (
                <section aria-label="Explorar carpetas">
                  <p>{directories.path}</p>
                  {directories.parent && (
                    <Button
                      onClick={() => {
                        if (directories.parent) browse(directories.parent);
                      }}
                    >
                      Carpeta superior
                    </Button>
                  )}
                  <ul>
                    {directories.directories.map((directory) => (
                      <li key={directory}>
                        <Button
                          onClick={() =>
                            browse(`${directories.path?.replace(/[\\/]+$/, '')}/${directory}`)
                          }
                        >
                          {directory}
                        </Button>
                      </li>
                    ))}
                  </ul>
                  <Button
                    onClick={() => {
                      const draft: ProjectDraft = {
                        ...state.draft,
                        parentPath: directories.path ?? '',
                        folderMode: 'existing',
                      };
                      dispatch({ type: 'edit', draft });
                      send('validate', {
                        type: 'validateNewProject',
                        requestId: requestId(),
                        ...draft,
                      });
                    }}
                  >
                    Comprobar esta carpeta
                  </Button>
                </section>
              )}
              {state.error === 'existing_available' && validationPath && (
                <Button
                  onClick={() => {
                    dispatch({
                      type: 'edit',
                      draft: { parentPath: validationPath, folderMode: 'existing' },
                    });
                  }}
                >
                  Usar la carpeta existente
                </Button>
              )}
              <Button
                disabled={!state.draft.parentPath}
                onClick={() =>
                  send('validate', {
                    type: 'validateNewProject',
                    requestId: requestId(),
                    ...state.draft,
                  })
                }
              >
                Comprobar carpeta
              </Button>
            </>
          )}
          {state.step === 'hosting' && (
            <>
              <label htmlFor="new-project-hosting">Alojamiento</label>
              <select
                id="new-project-hosting"
                value={state.draft.hosting}
                onChange={(event) =>
                  dispatch({
                    type: 'edit',
                    draft: {
                      hosting: event.target.value === 'github_private' ? 'github_private' : 'local',
                    },
                  })
                }
              >
                <option value="local">Solo local</option>
                <option value="github_private">GitHub (privado)</option>
              </select>
              {state.draft.hosting === 'github_private' && (
                <p>
                  Después de preparar el proyecto podrás conectar tu cuenta y confirmar la creación
                  del repositorio.
                </p>
              )}
              <Button onClick={() => dispatch({ type: 'next' })}>Siguiente</Button>
            </>
          )}
          {state.step === 'confirm' && (
            <>
              <dl>
                <dt>Nombre</dt>
                <dd>{state.draft.name}</dd>
                <dt>Ruta local</dt>
                <dd>{state.validation?.path}</dd>
                <dt>Alojamiento</dt>
                <dd>{projectHostingText(state.draft.hosting)}</dd>
              </dl>
              {state.draft.hosting === 'github_private' && (
                <p>La creación en GitHub se confirmará en el siguiente paso.</p>
              )}
              <p>
                Se preparará el repositorio Git, el archivo de proyecto y su carpeta de
                conocimiento.
              </p>
              <Button
                onClick={() =>
                  send('create', {
                    type: 'createNewProject',
                    requestId: requestId(),
                    ...state.draft,
                  })
                }
              >
                Crear proyecto
              </Button>
            </>
          )}
          {['path', 'hosting', 'confirm'].includes(state.step) && (
            <Button onClick={() => dispatch({ type: 'back' })}>Anterior</Button>
          )}
        </fieldset>
        {state.pending && (
          <div role="status">
            <StatusChip state="RUNNING" />
            <p>{state.step === 'creating' ? 'Preparando proyecto…' : 'Comprobando…'}</p>
          </div>
        )}
        {state.validation?.status === 'ready' && ['hosting', 'confirm'].includes(state.step) && (
          <div role="status">
            <StatusChip state="READY" />
            <p>Carpeta comprobada. Se volverá a validar al crear.</p>
          </div>
        )}
        {(state.step === 'created' || state.step === 'github') && (
          <div role="status">
            <StatusChip state="DONE" />
            <p>{state.result?.path}</p>
            {state.step === 'created' && (
              <p>
                Alojamiento elegido{' '}
                {projectHostingText(state.result?.hosting ?? state.draft.hosting)}
              </p>
            )}
          </div>
        )}
        {state.step === 'github' && state.result?.projectId && (
          <GithubHostingWizard key={state.result.projectId} projectId={state.result.projectId} />
        )}
        {state.step === 'uncertain' && (
          <p role="alert">
            No se pudo confirmar la creación. Revisa la carpeta {state.validation?.path} antes de
            volver a crear el proyecto.
          </p>
        )}
        {state.error && (
          <div role="alert">
            <StatusChip state="BLOCKED" />
            <p>{newProjectErrorText(state.error)}</p>
          </div>
        )}
        <Button disabled={state.step === 'creating'} onClick={close}>
          {state.step === 'created' || state.step === 'github' ? 'Ver el proyecto' : 'Cancelar'}
        </Button>
      </div>
    </Modal>
  );
}
