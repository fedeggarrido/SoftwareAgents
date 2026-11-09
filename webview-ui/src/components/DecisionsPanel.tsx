import { useBoard } from '../office/boardStore.js';
import { decisionOptions } from '../office/decisionOptions.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';

interface DecisionsPanelProps {
  hosted?: boolean;
  isOpen: boolean;
  onClose: () => void;
}

/** Owner decisions the agents may recommend but never take. Structured answers restore blocked tasks; legacy answers use the inbox. */
export function DecisionsPanel({ isOpen, onClose, hosted = false }: DecisionsPanelProps) {
  const board = useBoard();
  if (!isOpen) return null;
  const decisions = board?.decisions ?? [];
  return (
    <div
      className="read-only-panel p-10 flex flex-col gap-8"
      data-testid="decisions-panel"
      role="region"
      aria-label="Decisiones"
    >
      {!hosted && (
        <div className="flex items-center gap-8">
          <span className="text-lg flex-1">Decisiones del propietario</span>
          <Button size="sm" variant="ghost" onClick={onClose} title="Cerrar">
            ✕
          </Button>
        </div>
      )}
      <div className="text-2xs text-text-muted">
        Los agentes recomiendan; solo tú decides. Las decisiones estructuradas restauran las tareas
        bloqueadas; las respuestas legacy las aplica el manager.
      </div>
      {decisions.length === 0 && (
        <div className="text-xs text-text-muted">No hay decisiones pendientes.</div>
      )}
      {decisions.map((d) => (
        <div key={d.id} className="bg-bg-dark border-2 border-border p-8 flex flex-col gap-4">
          <div className="text-sm">
            <span className="text-text-muted">{d.id}</span> {d.question}
          </div>
          {d.context && <div className="text-2xs text-text-muted leading-tight">{d.context}</div>}
          {d.recommendation && (
            <div className="text-2xs leading-tight">Recomendación: {d.recommendation}</div>
          )}
          {d.impact && (
            <div className="text-2xs">
              Impacto: {d.impact} / Urgencia: {d.urgency}
            </div>
          )}
          {d.requestedBy && <div className="text-2xs">Solicita: {d.requestedBy}</div>}
          {d.disagreement?.map((position, i) => (
            <div key={i} className="text-2xs">
              {position.role}: {position.position}
            </div>
          ))}
          {d.blocks && d.blocks.length > 0 && (
            <div className="text-2xs text-text-muted">Bloquea: {d.blocks.join(', ')}</div>
          )}
          {d.status === 'answered' ? (
            <div className="text-xs">
              Respondida: {d.answer}{' '}
              {d.answeredBy ? `/ ${d.answeredBy}` : ' / pendiente de aplicar'}
            </div>
          ) : d.status === 'expired' ? (
            <div className="text-xs">Expirada</div>
          ) : (
            <div className="flex gap-6 flex-wrap">
              {decisionOptions(d).map(({ id, label, details }) => {
                return (
                  <Button
                    key={id}
                    size="sm"
                    onClick={() =>
                      transport.send({ type: 'companyDecision', id: d.id, answer: id })
                    }
                  >
                    {label}
                    {details && (
                      <span className="block text-2xs">
                        Beneficio: {details.benefit}
                        <br />
                        Coste: {details.cost}
                        <br />
                        Riesgo: {details.risk}
                      </span>
                    )}
                  </Button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
