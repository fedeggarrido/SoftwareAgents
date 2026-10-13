import type { ExecutorAvailability, ModelTier } from '../../../core/src/messages.js';
import { EXECUTOR_STATUS_COLORS } from '../constants.js';
import type { ExecutorStore } from './executorStore.js';

// What the «Executors para nuevas tareas» panel shows (docs/design/executor-toggles.md,
// UX section). The switch is the Operator's choice; the status text is current
// eligibility. Unknown is never shown as available. DOM-free for unit tests.

const LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
const LEVEL_TEXT: Record<string, string> = {
  economy: 'economy',
  standard: 'standard',
  deep: 'deep',
};

/** SA-092: one level the Operator may allow or disallow for this Executor. */
export interface ExecutorLevelView {
  tier: ModelTier;
  label: string;
  allowed: boolean;
  /** Accessible name of the checkbox. */
  ariaLabel: string;
}

export interface ExecutorRowView {
  executorId: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  pending: boolean;
  status: string;
  color: string;
  details: string[];
  error: string | null;
  /** Accessible name of the switch. */
  ariaLabel: string;
  /**
   * Editable levels, only for a manager on a server that offers them (catalogLevels)
   * and a Project with a level catalog. Read-only viewers see levels in `details`.
   */
  levelControls: ExecutorLevelView[] | null;
}

export interface ExecutorPanelView {
  projectId: string;
  rows: ExecutorRowView[];
  readOnlyNotice: string | null;
  /** Persistent banner (never a modal): all off, or a change without verified result. */
  banner: string | null;
  /** Polite live-region text for screen readers. */
  live: string;
}

function ago(fromS: number, nowS: number): string {
  const s = Math.max(0, Math.round(nowS - fromS));
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  return `hace ${Math.round(s / 3600)} h`;
}

/** Main status: the single most important reason, in the design's priority order. */
export function executorStatus(
  e: ExecutorAvailability,
  nowS: number,
): { text: string; color: string } {
  const has = (code: string) => e.reasonCodes.includes(code as never);
  if (has('configuration_unavailable') && !e.enabled)
    return { text: 'Configuración no disponible', color: EXECUTOR_STATUS_COLORS.blocked };
  if (!e.enabled) return { text: 'Desactivado', color: EXECUTOR_STATUS_COLORS.off };
  if (has('not_installed')) return { text: 'No instalado', color: EXECUTOR_STATUS_COLORS.blocked };
  if (has('unsupported_version'))
    return { text: 'Versión incompatible', color: EXECUTOR_STATUS_COLORS.blocked };
  if (has('auth_required'))
    return { text: 'Autenticación necesaria', color: EXECUTOR_STATUS_COLORS.blocked };
  if (has('configuration_unavailable'))
    return { text: 'Configuración no disponible', color: EXECUTOR_STATUS_COLORS.blocked };
  if (has('no_allowed_level'))
    return { text: 'Sin nivel permitido', color: EXECUTOR_STATUS_COLORS.blocked };
  if (has('quota_blocked')) return { text: 'Sin cuota', color: EXECUTOR_STATUS_COLORS.warning };
  if (has('concurrency_full'))
    return { text: 'Límite de concurrencia', color: EXECUTOR_STATUS_COLORS.warning };
  if (!e.eligible) return { text: 'No admisible ahora', color: EXECUTOR_STATUS_COLORS.warning };
  const stale = e.staleAfter !== null && nowS > e.staleAfter;
  if (e.installation === 'unknown' || e.checkedAt === null || stale)
    return { text: 'Desconocido · comprobando', color: EXECUTOR_STATUS_COLORS.unknown };
  return { text: 'Disponible', color: EXECUTOR_STATUS_COLORS.available };
}

function details(e: ExecutorAvailability, nowS: number): string[] {
  const lines: string[] = [];
  const disallowed = (e.catalogLevels ?? []).filter((l) => !e.levels.includes(l));
  const levels = [
    e.levels.map((l) => LEVEL_TEXT[l] ?? l).join(', ') ||
      (e.catalogLevels?.length ? 'ningún nivel permitido' : ''),
    disallowed.length
      ? `(no permitido: ${disallowed.map((l) => LEVEL_TEXT[l] ?? l).join(', ')})`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  const runs = e.activeExecutions === null ? '? ejecuciones' : `${e.activeExecutions} ejecuciones`;
  const limit = e.concurrencyLimit === null ? 'límite desconocido' : `límite ${e.concurrencyLimit}`;
  lines.push([levels || null, `${runs} / ${limit}`].filter(Boolean).join(' · '));
  const quota =
    e.quotaGate === 'allow'
      ? 'Cuota observada sana'
      : e.quotaGate === 'block'
        ? 'Cuota agotada'
        : 'Cuota desconocida';
  const probe =
    e.checkedAt === null
      ? 'sin comprobar'
      : `${e.version ? `v${e.version} · ` : ''}comprobado ${ago(e.checkedAt, nowS)}`;
  lines.push(`${quota} · ${probe}`);
  // Off keeps the technical diagnosis in the detail, not as the main status.
  if (!e.enabled) {
    const diag = [
      e.installation === 'missing' && 'no instalado',
      e.installation === 'unsupported' && 'versión incompatible',
      e.authentication === 'required' && 'autenticación necesaria',
    ].filter(Boolean);
    if (diag.length) lines.push(`Diagnóstico: ${diag.join(', ')}`);
    if ((e.activeExecutions ?? 0) > 0) lines.push('Las ejecuciones en curso terminan');
  }
  return lines;
}

export function executorPanelView(store: ExecutorStore, nowMs: number): ExecutorPanelView | null {
  const state = store.state;
  if (!state) return null;
  const nowS = nowMs / 1000;
  const rows = state.executors.map((e): ExecutorRowView => {
    const pending = store.pending[e.executorId];
    const label = LABELS[e.executorId] ?? e.executorId;
    const status = pending
      ? { text: 'Guardando…', color: EXECUTOR_STATUS_COLORS.unknown }
      : executorStatus(e, nowS);
    const editable =
      state.canManage && state.configurationStatus === 'ready' && !!e.catalogLevels?.length;
    return {
      executorId: e.executorId,
      label,
      checked: e.enabled,
      disabled: !state.canManage || !!pending || state.configurationStatus === 'recovery_required',
      pending: !!pending,
      status: status.text,
      color: status.color,
      details: details(e, nowS),
      error: store.errors[e.executorId] ?? null,
      ariaLabel: `${label} para nuevas tareas de ${state.projectId}: ${e.enabled ? 'activado' : 'desactivado'}, ${status.text}`,
      levelControls: editable
        ? e.catalogLevels!.map((tier) => {
            const allowed = e.levels.includes(tier);
            const text = LEVEL_TEXT[tier] ?? tier;
            return {
              tier,
              label: text,
              allowed,
              ariaLabel: `Nivel ${text} de ${label} en ${state.projectId}: ${allowed ? 'permitido' : 'no permitido'}`,
            };
          })
        : null,
    };
  });
  const allOff = state.executors.length > 0 && state.executors.every((e) => !e.enabled);
  const banner =
    state.configurationStatus === 'recovery_required'
      ? 'Un cambio de disponibilidad no tiene resultado verificado: lanzamientos bloqueados hasta «pixel-agents executors recover».'
      : state.configurationStatus === 'invalid'
        ? 'Configuración del operador no disponible o inválida: no se lanza nada.'
        : allOff
          ? 'Nuevas tareas bloqueadas: todos los executors están desactivados.'
          : null;
  const live = [
    banner,
    ...rows.filter((r) => r.pending || r.error).map((r) => `${r.label}: ${r.error ?? r.status}`),
  ]
    .filter(Boolean)
    .join(' ');
  return {
    projectId: state.projectId,
    rows,
    readOnlyNotice: state.canManage ? null : 'Solo el operador puede cambiar la disponibilidad.',
    banner,
    live,
  };
}
