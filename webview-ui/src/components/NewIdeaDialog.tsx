import { useEffect, useState, useSyncExternalStore } from 'react';

import { IDEA_REQUEST_TIMEOUT_MS, IDEA_TEXTAREA_ROWS } from '../constants.js';
import {
  getIdeasStore,
  ideaDialogState,
  ideaErrorText,
  invalidateIdeas,
  requestIdeas,
  sendIdea,
  setIdeasStore,
  useIdeasStore,
} from '../office/ideasStore.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

const subscribeTransport = (listener: () => void) => transport.onStateChange(listener);
const transportState = () => transport.state;

export function NewIdeaDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const store = useIdeasStore();
  const connection = useSyncExternalStore(subscribeTransport, transportState, transportState);
  const state = ideaDialogState(store, connection === 'connected');
  useEffect(() => {
    // A new dialog can compose another idea, but never replay an uncertain submission.
    setIdeasStore({ ...getIdeasStore(), result: null });
    if (transport.state === 'connected') requestIdeas(transport);
  }, []);
  useEffect(() => {
    if (!store.pending) return;
    const requestId = store.pending.requestId;
    const timer = setTimeout(() => {
      if (getIdeasStore().pending?.requestId === requestId)
        setIdeasStore(invalidateIdeas(getIdeasStore()));
    }, IDEA_REQUEST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [store.pending]);
  useEffect(() => {
    if (connection === 'connected' && !getIdeasStore().requestId) requestIdeas(transport);
  }, [connection]);
  const close = () => {
    if (!getIdeasStore().pending) onClose();
  };
  const writable = state === 'editing' || state === 'error';
  return (
    <Modal isOpen onClose={close} title="Nueva idea" className="idea-dialog">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Nueva idea"
        className="p-10 flex flex-col gap-8"
      >
        <p>
          Describe lo que necesitas. Guardar deja un borrador pendiente; no inicia ningún trabajo.
        </p>
        {state === 'saved' && store.result?.idea ? (
          <div role="status">
            <p>
              Idea guardada: <strong>{store.result.idea.key}</strong> · pendiente
            </p>
            <p>Para continuar, ejecuta desde este checkout:</p>
            <code className="feature-command block">{store.result.idea.command}</code>
            <p>El comando pedirá el token del operador de la oficina.</p>
            {store.result.errorCode && <p role="alert">{ideaErrorText(store.result.errorCode)}</p>}
          </div>
        ) : (
          <>
            <label htmlFor="new-idea-text">Tu idea</label>
            <textarea
              id="new-idea-text"
              rows={IDEA_TEXTAREA_ROWS}
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={!writable}
              className="bg-bg-dark text-text border-2 border-border p-8 w-full"
            />
            <div role={state === 'error' || state === 'uncertain' ? 'alert' : 'status'}>
              {state === 'loading' && 'Comprobando el Project…'}
              {state === 'disabled' && ideaErrorText(store.snapshot?.errorCode)}
              {state === 'error' && ideaErrorText(store.result?.errorCode)}
              {state === 'offline' && 'Sin conexión. Reconecta para guardar la idea.'}
              {state === 'saving' && 'Guardando…'}
              {state === 'uncertain' &&
                'No se pudo confirmar el guardado. Consulta las ideas pendientes antes de enviar otra; el envío no se repetirá automáticamente.'}
            </div>
            <Button disabled={!writable || !text.trim()} onClick={() => sendIdea(text, transport)}>
              {state === 'saving' ? 'Guardando…' : 'Guardar idea'}
            </Button>
            {state === 'uncertain' && (
              <Button
                onClick={() => {
                  setIdeasStore({ ...getIdeasStore(), uncertain: false });
                  requestIdeas(transport);
                  onClose();
                }}
              >
                Consultar ideas pendientes
              </Button>
            )}
          </>
        )}
        <Button disabled={state === 'saving'} onClick={close}>
          Cerrar
        </Button>
      </div>
    </Modal>
  );
}
