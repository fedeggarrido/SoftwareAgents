import type {
  ServerMessage,
  SubmitTaskChange,
  TaskDetail,
  TaskDetailError,
} from '../../../core/src/messages.js';
import type { MessageTransport } from '../../../core/src/transport.js';
import { FEATURE_PLAN_TIMEOUT_MS } from '../constants.js';
import { newRequestId } from './requestId.js';

export const taskDetailErrorText = (code: TaskDetailError | null): string => {
  switch (code) {
    case 'denied':
      return 'Solo lectura. Pedir un cambio requiere acceso de operador.';
    case 'managed_process':
      return 'Esta oficina se inició desde un agente. La confirmación necesita una oficina abierta por una persona.';
    case 'unsupported_adapter':
      return 'Esta oficina permite consultar la tarea. Los cambios requieren la oficina del navegador.';
    case 'stale_revision':
      return 'La tarea o su impacto han cambiado. Actualiza y revisa antes de confirmar de nuevo.';
    case 'unknown_project':
      return 'El proyecto ha cambiado. Vuelve a abrir la tarea.';
    default:
      return 'No se pudo consultar la tarea. Pulsa Actualizar para reintentar.';
  }
};

interface TaskDetailView {
  detail: TaskDetail | null;
  pending: boolean;
  loading: boolean;
  notice: string;
}

export class TaskDetailController {
  private view: TaskDetailView = { detail: null, pending: false, loading: false, notice: '' };
  private listeners = new Set<() => void>();
  private readId: string | null = null;
  private writeId: string | null = null;
  private submission: SubmitTaskChange | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  private transport: MessageTransport;
  private projectId: string;
  private key: string;
  constructor(transport: MessageTransport, projectId: string, key: string) {
    this.transport = transport;
    this.projectId = projectId;
    this.key = key;
  }
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(view: TaskDetailView) {
    this.view = view;
    for (const listener of this.listeners) listener();
  }
  private invalidate(notice: string) {
    clearTimeout(this.timer);
    this.readId = this.writeId = null;
    this.update({ detail: null, pending: false, loading: false, notice });
  }
  private deadline() {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () =>
        this.invalidate(
          'No se pudo confirmar la operación. Actualiza para comprobar el resultado antes de volver a pedir el cambio.',
        ),
      FEATURE_PLAN_TIMEOUT_MS,
    );
  }
  start() {
    const off = this.transport.onMessage(this.receive);
    const offState = this.transport.onStateChange((state) => {
      this.invalidate(
        'La conexión ha cambiado. Vuelve a leer la tarea y el impacto antes de confirmar.',
      );
      if (state === 'connected') this.refresh();
    });
    this.refresh();
    return () => {
      clearTimeout(this.timer);
      off();
      offState();
    };
  }
  refresh = () => this.read('');
  private read(notice: string) {
    if (this.view.pending || this.transport.state !== 'connected') return;
    this.readId = newRequestId();
    this.update({ ...this.view, detail: null, loading: true, notice });
    this.deadline();
    this.transport.send({
      type: 'requestTaskDetail',
      projectId: this.projectId,
      key: this.key,
      requestId: this.readId,
    });
  }
  confirm = (text: string) => {
    if (
      !text.trim() ||
      this.view.pending ||
      !this.view.detail?.canChange ||
      this.transport.state !== 'connected'
    )
      return;
    // An explicit retry of an uncertain confirmation reuses its durable idempotency key.
    const request: SubmitTaskChange =
      this.submission?.text === text
        ? this.submission
        : {
            type: 'submitTaskChange',
            projectId: this.projectId,
            key: this.key,
            requestId: newRequestId(),
            revision: this.view.detail.revision,
            text,
          };
    this.submission = request;
    this.writeId = request.requestId;
    this.update({ ...this.view, pending: true, notice: '' });
    this.deadline();
    try {
      this.transport.send(request);
    } catch {
      this.invalidate(
        'La conexión con la oficina se ha cerrado. Actualiza la tarea y vuelve a confirmar el cambio.',
      );
    }
  };
  receive = (message: ServerMessage) => {
    if (message.type !== 'taskDetailSnapshot' && message.type !== 'taskChangeResult') return;
    if (message.projectId !== this.projectId || message.key !== this.key) return;
    if (message.type === 'taskDetailSnapshot') {
      if (message.requestId !== this.readId) return;
      clearTimeout(this.timer);
      this.readId = null;
      this.update({
        ...this.view,
        detail: message.detail,
        loading: false,
        notice: message.errorCode ? taskDetailErrorText(message.errorCode) : this.view.notice,
      });
    } else {
      if (message.requestId !== this.writeId) return;
      this.submission = null;
      const notice = message.errorCode
        ? taskDetailErrorText(message.errorCode)
        : message.followUpKey
          ? 'Tarea de seguimiento creada, pendiente de planificar.'
          : 'Cambio registrado. Revisa las decisiones pendientes antes de continuar.';
      this.invalidate(notice);
      this.read(notice);
    }
  };
}
