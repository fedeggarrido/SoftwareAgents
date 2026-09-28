import { QUOTA_COLORS } from '../constants.js';
import type { BoardEvent, ProviderQuota } from '../office/boardStore.js';
import { useBoard } from '../office/boardStore.js';

function clock(epochS: number | null): string {
  if (!epochS) return '—';
  return new Date(epochS * 1000).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** What the gauge can truthfully say about a provider, never more. */
function describe(q: ProviderQuota): { text: string; pct: number | null; color: string } {
  switch (q.status) {
    case 'rejected':
      return {
        text: `agotada · vuelve ${clock(q.resetsAt)}`,
        pct: 100,
        color: QUOTA_COLORS.rejected,
      };
    case 'warning':
      return {
        text: `${q.usedPercent ?? '≥90'}% · reinicia ${clock(q.resetsAt)}`,
        pct: q.usedPercent,
        color: QUOTA_COLORS.warning,
      };
    case 'allowed':
      return q.usedPercent !== null
        ? {
            text: `${q.usedPercent}% · reinicia ${clock(q.resetsAt)}`,
            pct: q.usedPercent,
            color: QUOTA_COLORS.allowed,
          }
        : { text: `<90% · reinicia ${clock(q.resetsAt)}`, pct: null, color: QUOTA_COLORS.allowed };
    case 'reset':
      return { text: 'ventana reiniciada', pct: null, color: QUOTA_COLORS.allowed };
    default:
      return { text: 'sin datos aún', pct: null, color: QUOTA_COLORS.unknown };
  }
}

function Row({ name, q }: { name: string; q: ProviderQuota }) {
  const d = describe(q);
  return (
    <div
      className="flex items-center gap-6 text-2xs leading-none"
      title={
        q.observedAt
          ? `Última observación ${clock(q.observedAt)}. Claude solo informa del % a partir del 90 %.`
          : 'Aún no se ha observado ninguna ejecución de este proveedor.'
      }
    >
      <span className="w-60">{name}</span>
      <span className="w-80 h-8 border border-border bg-bg-dark">
        <span
          className="block h-full"
          style={{
            width: `${d.pct ?? (q.status === 'unknown' ? 0 : 100)}%`,
            background: d.color,
            opacity: d.pct === null ? 0.35 : 1,
          }}
        />
      </span>
      <span style={{ color: d.color }}>{d.text}</span>
      {q.weekly && q.weekly.usedPercent !== null && (
        <span className="text-text-muted">· semana {q.weekly.usedPercent}%</span>
      )}
    </div>
  );
}

function GateLine({ e }: { e: BoardEvent }) {
  const held = e.state === 'WAIT';
  return (
    <div
      className="text-2xs leading-tight overflow-hidden text-ellipsis whitespace-nowrap"
      style={{ color: held ? QUOTA_COLORS.rejected : undefined }}
      title={e.detail}
    >
      {held ? '⏸ ' : '▶ '}
      {e.session} · {e.detail.replace(/^Puerta de cuota: /, '')}
    </div>
  );
}

/** Quota of each provider and the last launch decisions of the quota gate. */
export function QuotaHud() {
  const board = useBoard();
  if (!board?.quota) return null;
  const gate = board.gate ?? [];
  return (
    <div
      className="absolute top-10 left-1/2 -translate-x-1/2 z-20 pixel-panel px-8 py-4 flex flex-col gap-3 max-w-[60%]"
      data-testid="quota-hud"
    >
      <Row name="Claude" q={board.quota.claude} />
      <Row name="Codex" q={board.quota.codex} />
      {gate[0] && <GateLine e={gate[0]} />}
    </div>
  );
}
