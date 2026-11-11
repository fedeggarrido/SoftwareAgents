import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { BoardItem, BoardState } from '../../../core/src/messages.js';
import {
  TASK_CHANGE_MAX_CHARS,
  TASK_CHANGE_TEXT,
  taskChangeImpact,
  taskChangePolicy,
} from '../../../core/src/taskChangePolicy.js';
import { useOfficeAccess } from '../office/accessStore.js';
import { decisionOptions } from '../office/decisionOptions.js';
import { knownText } from '../office/displayText.js';
import { readableStateText, taskStateExplanation } from '../office/statusPresentation.js';
import { TaskDetailController } from '../office/taskDetailController.js';
import { taskPrDescription, taskTitle } from '../office/taskDetailPresentation.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { StatusChip } from './StatusChip.js';
import { Button } from './ui/Button.js';

export function TaskDetail({
  item,
  board,
  onBack,
  onSelectTask,
}: {
  item: BoardItem;
  board: BoardState;
  onBack: () => void;
  onSelectTask: (key: string) => void;
}) {
  const [controller] = useState(
    () => new TaskDetailController(transport, board.projectId ?? '', item.id),
  );
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const access = useOfficeAccess();
  const [mode, setMode] = useState<'detail' | 'edit' | 'confirm'>('detail');
  const [text, setText] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => controller.start(), [controller]);
  useEffect(() => {
    if (!view.detail) setMode('detail');
  }, [view.detail]);
  const detail = view.detail;
  const task = detail?.item ?? item;
  const kind = taskChangePolicy(task.phase);
  const writable =
    isBrowserRuntime &&
    access?.privileged === true &&
    access.reason === null &&
    detail?.canChange === true;
  const decisions =
    detail?.decisions ??
    board.decisions.filter(
      (decision) =>
        decision.status !== 'answered' &&
        (decision.blocks?.includes(item.id) ||
          (!!item.epic && decision.blocks?.includes(item.epic))),
    );
  const impact = detail?.impact ?? taskChangeImpact(item, board.items);
  const description = readableStateText(detail?.description ?? item.note);
  const explanation = taskStateExplanation(task.phase);
  const feature = knownText(detail?.featureTitle) ?? knownText(task.epic);
  const dependencies = task.dependsOn?.map(
    (key) => board.items.find((candidate) => candidate.id === key) ?? { id: key, title: key },
  );
  return (
    <section
      className="task-detail flex flex-col gap-8"
      data-testid="task-detail"
      aria-label="Detalle de tarea"
    >
      <div className="flex flex-wrap gap-6">
        <Button onClick={onBack}>Volver a Trabajo</Button>
        <Button onClick={controller.refresh} disabled={view.pending || view.loading}>
          Actualizar
        </Button>
      </div>
      <h3 className="text-lg" tabIndex={-1} ref={heading}>
        {taskTitle(task)}
      </h3>
      {feature && <p>Funcionalidad {feature}</p>}
      {detail?.origin && (
        <div>
          <p>Seguimiento de {taskTitle(detail.origin)}</p>
          <Button onClick={() => onSelectTask(detail.origin!.id)}>Ver tarea original</Button>
        </div>
      )}
      <div className="self-start">
        <StatusChip state={task.phase} />
      </div>
      {explanation && <p>{explanation}</p>}
      {description ? (
        <p className="whitespace-pre-wrap">{description}</p>
      ) : (
        <p>
          Esta tarea aún no tiene una descripción registrada. Puedes consultar su estado y sus
          decisiones pendientes.
        </p>
      )}
      <section aria-label="Decisiones pendientes">
        <h4>Decisiones pendientes</h4>
        {decisions.length === 0 && <p>No hay decisiones pendientes para esta tarea.</p>}
        {decisions.map((decision) => (
          <div key={decision.id} className="border-2 border-border p-8">
            <p className="whitespace-pre-wrap">{readableStateText(decision.question)}</p>
            <ul>
              {decisionOptions(decision).map((option) => (
                <li key={option.id}>
                  <strong>{readableStateText(option.label)}</strong>
                  {option.details && (
                    <p>
                      {[option.details.benefit, option.details.cost, option.details.risk]
                        .map(readableStateText)
                        .filter(Boolean)
                        .join(' ')}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
      <section aria-label="Dependencias">
        <h4>Dependencias</h4>
        {dependencies?.length ? (
          <ul>
            {dependencies.map((dependency) => (
              <li key={dependency.id}>{taskTitle(dependency)}</li>
            ))}
          </ul>
        ) : (
          <p>Esta tarea puede avanzar sin esperar a otras tareas.</p>
        )}
      </section>
      <section aria-label="Propuesta de cambios">
        <h4>Propuesta de cambios</h4>
        <p>{taskPrDescription(task)}</p>
        {task.prStatus?.failedChecks.map((check) => (
          <p key={check}>{readableStateText(check)}</p>
        ))}
      </section>
      {view.loading && <p role="status">Leyendo la tarea y su impacto…</p>}
      {view.notice && <p role="status">{view.notice}</p>}
      {kind && (
        <section aria-label="Pedir un cambio" className="flex flex-col gap-6">
          <h4>Pedir un cambio</h4>
          <p>{TASK_CHANGE_TEXT[kind]}</p>
          {/* The status notice above already explains a denied connection; say it once. */}
          {!writable && !view.notice && (
            <p>
              Solo lectura. Puedes consultar lo que haría esta acción. Para confirmar necesitas una
              oficina abierta por ti con acceso de operador.
            </p>
          )}
          {mode === 'detail' && (
            <Button
              disabled={!writable || view.pending}
              onClick={() => {
                setText(kind === 'revise_spec' ? (detail?.description ?? '') : '');
                setMode('edit');
              }}
            >
              Pedir un cambio
            </Button>
          )}
          {mode !== 'detail' && (
            <>
              <label className="flex flex-col gap-4">
                {kind === 'revise_spec' ? 'Especificación editada' : 'Qué quieres cambiar'}
                <textarea
                  rows={6}
                  maxLength={TASK_CHANGE_MAX_CHARS}
                  value={text}
                  disabled={mode === 'confirm' || view.pending}
                  onChange={(event) => setText(event.target.value)}
                />
              </label>
              {mode === 'edit' ? (
                <Button disabled={!text.trim() || !writable} onClick={() => setMode('confirm')}>
                  Revisar impacto
                </Button>
              ) : (
                <>
                  <h4>Tareas que podrían verse afectadas</h4>
                  <p>Incluye las tareas dependientes y las de la misma funcionalidad.</p>
                  {impact.length ? (
                    <ul data-testid="task-change-impact">
                      {impact.map((affected) => (
                        <li key={affected.id}>
                          {taskTitle(affected)} <StatusChip state={affected.phase} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No hay otras tareas afectadas registradas.</p>
                  )}
                  <p>{TASK_CHANGE_TEXT[kind]}</p>
                  <Button
                    variant="primary"
                    disabled={!writable || view.pending}
                    onClick={() => controller.confirm(text)}
                  >
                    {view.pending ? 'Guardando…' : 'Confirmar cambio'}
                  </Button>
                  <Button disabled={view.pending} onClick={() => setMode('edit')}>
                    Volver a editar
                  </Button>
                </>
              )}
              <Button disabled={view.pending} onClick={() => setMode('detail')}>
                Cancelar
              </Button>
            </>
          )}
        </section>
      )}
    </section>
  );
}
