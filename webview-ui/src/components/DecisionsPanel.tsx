import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { HumanDecisionOption } from '../../../core/src/messages.js';
import { roleLabel } from '../i18n/roles.js';
import { getBoardState, subscribeBoard, useBoard } from '../office/boardStore.js';
import { decisionOptions, decisionUrgency } from '../office/decisionOptions.js';
import type { DecisionReview } from '../office/decisionReview.js';
import { reconcileDecisionReview, reviewDecision } from '../office/decisionReview.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';

interface DecisionsPanelProps {
  hosted?: boolean;
  isOpen: boolean;
  onClose: () => void;
}

const subscribeTransport = (listener: () => void) => transport.onStateChange(listener);
const transportState = () => transport.state;

function Consequences({ details }: { details?: HumanDecisionOption }) {
  return details ? (
    <dl className="decision-consequences">
      <dt>Beneficio</dt>
      <dd>{details.benefit || 'Sin beneficio registrado'}</dd>
      <dt>Coste</dt>
      <dd>{details.cost || 'Sin coste registrado'}</dd>
      <dt>Riesgo</dt>
      <dd>{details.risk || 'Sin riesgo registrado'}</dd>
    </dl>
  ) : (
    <p>Sin consecuencias registradas</p>
  );
}

/** Only an explicit human confirmation sends the original option ID. */
export function DecisionsPanel({ isOpen, onClose, hosted = false }: DecisionsPanelProps) {
  const board = useBoard();
  const connection = useSyncExternalStore(subscribeTransport, transportState, transportState);
  const [review, setReview] = useState<DecisionReview>({ phase: 'choosing' });
  const reviewRef = useRef<DecisionReview>(review);
  const heading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const updateReview = (next: DecisionReview) => {
    reviewRef.current = next;
    setReview(next);
  };
  useEffect(
    () =>
      subscribeBoard(() => {
        const next = reconcileDecisionReview(reviewRef.current, getBoardState());
        reviewRef.current = next;
        setReview(next);
      }),
    [],
  );
  useEffect(() => {
    return transport.onStateChange(() => {
      if (transport.state !== 'connected' && reviewRef.current.phase === 'sent') {
        reviewRef.current = { phase: 'choosing' };
        setReview(reviewRef.current);
      } else if (transport.state !== 'connected' && reviewRef.current.phase === 'reviewing') {
        reviewRef.current = { phase: 'invalid' };
        setReview(reviewRef.current);
      }
    });
  }, []);
  useEffect(
    () =>
      transport.onMessage((message) => {
        // Notices have no decision correlation or success/rejection discriminator.
        // Release only the local send lock; the board remains the authority.
        if (message.type === 'companyNotice' && reviewRef.current.phase === 'sent') {
          reviewRef.current = { phase: 'choosing' };
          setReview(reviewRef.current);
        }
      }),
    [],
  );
  useEffect(() => {
    if (!isOpen) {
      reviewRef.current = { phase: 'choosing' };
      setReview(reviewRef.current);
    }
  }, [isOpen]);
  useEffect(() => {
    if (review.phase !== 'choosing') heading.current?.focus();
    else returnFocus.current?.focus();
  }, [review.phase]);
  if (!isOpen) return null;
  const currentReview = reconcileDecisionReview(review, board);
  const change = () => {
    updateReview({ phase: 'choosing' });
  };
  const confirm = () => {
    if (transport.state !== 'connected') {
      updateReview({ phase: 'invalid' });
      return;
    }
    const current = reconcileDecisionReview(reviewRef.current, getBoardState());
    if (current.phase !== 'reviewing') {
      updateReview(current);
      return;
    }
    updateReview({ phase: 'sent', decisionId: current.decision.id });
    transport.send({ type: 'companyDecision', id: current.decision.id, answer: current.answer });
  };
  return (
    <div
      className="read-only-panel decisions-panel p-10 flex flex-col gap-8"
      data-testid="decisions-panel"
      role="region"
      aria-label="Decisiones"
    >
      {!hosted && (
        <div className="flex items-center gap-8">
          <h2 className="flex-1">Decisiones del propietario</h2>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      )}
      <p>
        Aquí aparecen las preguntas que los agentes no pueden decidir solos. Tú eliges; ellos
        continúan.
      </p>
      {currentReview.phase !== 'choosing' && (
        <section className="decision-review" aria-label="Revisar respuesta">
          <h3 ref={heading} tabIndex={-1}>
            Revisar respuesta
          </h3>
          {currentReview.phase === 'reviewing' ? (
            <>
              <p>{currentReview.decision.question}</p>
              <p>
                Vas a responder:{' '}
                <strong>
                  {
                    decisionOptions(currentReview.decision).find(
                      (option) => option.id === currentReview.answer,
                    )?.label
                  }
                </strong>
              </p>
              <Consequences
                details={currentReview.decision.structuredOptions?.find(
                  (option) => option.id === currentReview.answer,
                )}
              />
              <div className="flex gap-8 flex-wrap">
                <Button variant="primary" onClick={confirm}>
                  Confirmar
                </Button>
                <Button onClick={change}>Cambiar</Button>
              </div>
            </>
          ) : (
            <>
              <p role="status">
                {currentReview.phase === 'invalid'
                  ? 'La decisión ha cambiado, ya no está disponible o la ha resuelto otra persona. No se ha enviado tu respuesta. Revisa las opciones actuales.'
                  : 'Respuesta enviada. No consta que se haya aplicado. Esperando la actualización de la decisión.'}
              </p>
              <Button onClick={change}>Volver a las decisiones</Button>
            </>
          )}
        </section>
      )}
      {board?.decisions.length === 0 && <p>No hay decisiones pendientes.</p>}
      {board?.decisions.map((d) => (
        <section
          key={d.id}
          className="decision-card bg-bg-dark border-2 border-border p-8 flex flex-col gap-8"
        >
          <h3>{d.question}</h3>
          {d.context && <p>{d.context}</p>}
          {d.recommendation && <p>Recomendación: {d.recommendation}</p>}
          {d.impact && <p>Impacto: {d.impact}</p>}
          {d.urgency && <p>Urgencia: {decisionUrgency(d.urgency)}</p>}
          {d.requestedBy && <p>Solicita: {roleLabel(d.requestedBy)}</p>}
          {d.disagreement?.map((position, i) => (
            <p key={i}>
              {roleLabel(position.role)}: {position.position}
            </p>
          ))}
          {!!d.blocks?.length && (
            <div>
              Bloquea:
              <ul>
                {d.blocks.map((key) => (
                  <li key={key}>
                    {board.items.find((item) => item.id === key)?.title ??
                      'Tarea sin título registrado'}{' '}
                    <span className="text-text-muted">({key})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {d.status === 'answered' ? (
            <p>
              Respondida:{' '}
              {decisionOptions(d).find((option) => option.id === d.answer)?.label ?? d.answer}
              {d.answeredBy ? ` / ${roleLabel(d.answeredBy)}` : ' / pendiente de aplicar'}
            </p>
          ) : d.status === 'expired' ? (
            <p>Expirada</p>
          ) : d.status === 'open' ? (
            <ul className="decision-options">
              {decisionOptions(d).map(({ id, label, details }) => (
                <li key={id}>
                  <h4>{label}</h4>
                  <Consequences details={details} />
                  <Button
                    disabled={currentReview.phase !== 'choosing' || connection !== 'connected'}
                    onClick={(event) => {
                      if (reviewRef.current.phase !== 'choosing') return;
                      returnFocus.current = event.currentTarget;
                      if (board) updateReview(reviewDecision(board, d, id));
                    }}
                  >
                    {label}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p>Decisión no disponible</p>
          )}
        </section>
      ))}
    </div>
  );
}
