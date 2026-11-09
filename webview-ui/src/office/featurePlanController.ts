import type { FeaturePlanSnapshot, ServerMessage } from '../../../core/src/messages.js';
import type { MessageTransport } from '../../../core/src/transport.js';
import { FEATURE_PLAN_TIMEOUT_MS } from '../constants.js';
import { connectionCopy } from './connectionStatus.js';

export interface PlanView {
  snapshot: FeaturePlanSnapshot | null;
  loading: boolean;
  pending: boolean;
  notice: string;
}

export const planErrorText = (code: FeaturePlanSnapshot['errorCode']): string => {
  switch (code) {
    case 'denied':
      return 'Solo lectura. La aprobación requiere una conexión privilegiada del operador.';
    case 'unsupported_adapter':
      return 'Abre la oficina standalone para revisar y aprobar el plan.';
    case 'stale_revision':
      return 'El plan ha cambiado. Se ha solicitado la revisión actual. Léela antes de aprobar.';
    case 'unknown_project':
      return 'El proyecto ha cambiado. Vuelve a abrir el plan.';
    case 'approval_blocked':
      return 'La aprobación está bloqueada. Actualiza y revisa las preguntas, decisiones y la revisión Git.';
    default:
      return 'No se pudo leer el plan. Actualiza para reintentar.';
  }
};

let sequence = 0;

/** Per-dialog controller. All replies are scoped to Project, feature and request. */
export class FeaturePlanController {
  private view: PlanView = { snapshot: null, loading: true, pending: false, notice: '' };
  private listeners = new Set<() => void>();
  private readId: string | null = null;
  private approval: { id: string; revision: string } | null = null;
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
  private update(view: PlanView) {
    this.view = view;
    for (const listener of this.listeners) listener();
  }
  private deadline() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.readId = null;
      this.approval = null;
      this.update({
        snapshot: null,
        pending: false,
        loading: false,
        notice: 'La operación no se pudo confirmar. Actualiza para comprobar el estado.',
      });
    }, FEATURE_PLAN_TIMEOUT_MS);
  }
  start() {
    const offMessage = this.transport.onMessage(this.receive);
    const offState = this.transport.onStateChange((state) => {
      clearTimeout(this.timer);
      this.readId = null;
      this.approval = null;
      this.update({
        snapshot: null,
        pending: false,
        loading: false,
        notice:
          state === 'connected'
            ? 'Se ha recuperado la conexión con la oficina. Volviendo a leer el plan.'
            : `${connectionCopy(state).explanation} La aprobación requiere volver a leer el plan.`,
      });
      if (state === 'connected') this.read(this.view.notice);
    });
    this.refresh();
    return () => {
      clearTimeout(this.timer);
      offMessage();
      offState();
    };
  }
  /** A manual refresh replaces any earlier notice; an approval keeps its own outcome. */
  refresh = () => this.read('');
  private read(notice: string) {
    if (this.view.pending || this.transport.state !== 'connected') return;
    this.readId = `plan-${++sequence}`;
    this.update({ ...this.view, snapshot: null, loading: true, notice });
    this.deadline();
    this.transport.send({
      type: 'requestFeaturePlan',
      projectId: this.projectId,
      key: this.key,
      requestId: this.readId,
    });
  }
  approve = () => {
    const snapshot = this.view.snapshot;
    if (
      this.transport.state !== 'connected' ||
      this.view.pending ||
      !snapshot?.canApprove ||
      !snapshot.plan ||
      snapshot.plan.approved
    )
      return;
    const { revision } = snapshot.plan;
    this.approval = { id: `approve-plan-${++sequence}`, revision };
    this.update({ ...this.view, pending: true, notice: '' });
    this.deadline();
    this.transport.send({
      type: 'approveFeaturePlan',
      projectId: this.projectId,
      key: this.key,
      requestId: this.approval.id,
      revision,
    });
  };
  receive = (message: ServerMessage) => {
    if (message.type !== 'featurePlanSnapshot' && message.type !== 'featureApprovalResult') return;
    if (message.projectId !== this.projectId || message.key !== this.key) return;
    if (message.type === 'featurePlanSnapshot') {
      if (message.requestId !== this.readId) return;
      clearTimeout(this.timer);
      this.readId = null;
      this.update({
        ...this.view,
        snapshot: message,
        loading: false,
        notice: message.errorCode ? planErrorText(message.errorCode) : this.view.notice,
      });
    } else {
      if (message.requestId !== this.approval?.id || message.revision !== this.approval.revision)
        return;
      clearTimeout(this.timer);
      this.approval = null;
      const notice =
        message.status === 'approved' ? 'Plan aprobado.' : planErrorText(message.errorCode);
      this.update({ snapshot: null, loading: false, pending: false, notice });
      this.read(notice);
    }
  };
}
