import type { BoardState, ProviderQuota } from '../../../core/src/messages.js';
import { QUOTA_COLORS } from '../constants.js';
import { getProviderLabel } from './toolUtils.js';

/** Count tracked office sessions, including idle ones; subtask characters are not sessions. */
export function visibleProviderCounts(agents: readonly number[]) {
  const counts = { claude: 0, codex: 0 };
  for (const id of new Set(agents)) {
    const label = getProviderLabel(id);
    if (label === 'Claude') counts.claude++;
    else if (label.startsWith('Codex')) counts.codex++;
  }
  return counts;
}

function clock(epochS: number | null | undefined): string {
  if (!epochS) return '—';
  return new Date(epochS * 1000).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Keep the status readable without implying an exact value when none was reported. */
function describeQuota(q: ProviderQuota): { status: string; detail: string; color: string } {
  const weekly = q.weekly?.usedPercent;
  const usage = q.usedPercent === null ? 'Menos del 90 % usado' : `${q.usedPercent} % usado`;
  const weeklyDetail = weekly === null || weekly === undefined ? '' : ` · ${weekly} % esta semana`;
  const resetAt =
    weekly !== null && weekly !== undefined && weekly >= 100 ? q.weekly?.resetsAt : q.resetsAt;
  const resetDetail = resetAt ? ` · se renueva a las ${clock(resetAt)}` : '';
  switch (q.status) {
    case 'rejected':
      return {
        status: 'Agotada',
        detail: `${weekly !== null && weekly !== undefined && weekly >= 100 ? 'Límite semanal alcanzado' : 'Cuota agotada'}${resetDetail}`,
        color: QUOTA_COLORS.rejected,
      };
    case 'warning':
      return {
        status: 'Limitada',
        detail: `${q.usedPercent === null ? 'Al menos 90 % usado' : `${q.usedPercent} % usado`}${weeklyDetail}${resetDetail}`,
        color: QUOTA_COLORS.warning,
      };
    case 'allowed':
      return {
        status: 'Sana',
        detail: `${usage}${weeklyDetail}`,
        color: QUOTA_COLORS.allowed,
      };
    case 'reset':
      return {
        status: 'Desconocida',
        detail: 'La cuota se renovó; falta una nueva lectura',
        color: QUOTA_COLORS.unknown,
      };
    default:
      return {
        status: 'Desconocida',
        detail: 'Aún no hay una lectura de cuota',
        color: QUOTA_COLORS.unknown,
      };
  }
}

/** Presentation only: no React, transport or browser dependencies. */
export function capacityView(q: ProviderQuota, running: number) {
  return {
    ...describeQuota(q),
    provenance:
      running +
      (running === 1 ? ' agente en marcha · Fuente: ' : ' agentes en marcha · Fuente: ') +
      (q.capacity?.source ?? 'estimated') +
      ' · Confianza: ' +
      (q.capacity?.confidence ?? 'unknown'),
    windows:
      q.capacity?.windows.map((w) => {
        const label =
          w.kind === 'five_hour' ? '5 horas' : w.kind === 'weekly' ? 'Semanal' : 'Otra ventana';
        const usage =
          w.usedRatio === null ? 'uso desconocido' : Math.round(w.usedRatio * 100) + ' % usado';
        const reset =
          w.resetsAt === null
            ? '—'
            : new Date(w.resetsAt * 1000).toLocaleString('es-ES', {
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              });
        return label + ': ' + usage + ' · Reset: ' + reset;
      }) ?? [],
  };
}

/** Select the minimal HUD when the board source is unavailable. */
export function capacityHudView(board: BoardState) {
  return { minimal: !board.sources.board, title: 'Capacidad observada' };
}
