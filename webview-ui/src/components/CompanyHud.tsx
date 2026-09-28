import { useEffect, useState } from 'react';

import { PHASE_COLORS, QUOTA_COLORS } from '../constants.js';
import type { BoardEvent, ProviderQuota } from '../office/boardStore.js';
import { useBoard, useCompanyNotice } from '../office/boardStore.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';

function clock(epochS: number | null | undefined): string {
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

function QuotaRow({ name, q }: { name: string; q: ProviderQuota }) {
  const d = describe(q);
  return (
    <div
      className="flex items-center gap-6 text-2xs leading-none"
      title="Claude solo informa del % a partir del 90 %."
    >
      <span className="w-50">{name}</span>
      <span className="w-60 h-6 border border-border bg-bg-dark">
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

const AUTOPILOT_TEXT: Record<string, string> = {
  starting: 'arrancando',
  round: 'ronda de manager en curso',
  sleeping: 'esperando a la próxima ronda',
  waiting_quota: 'en espera de cuota',
  manager_busy: 'otro manager está en ronda',
  paused: 'en pausa',
};

interface CompanyHudProps {
  onOpenDecisions: () => void;
}

/** Project progress, autopilot, owner decisions, quota and who is held by the quota gate. */
export function CompanyHud({ onOpenDecisions }: CompanyHudProps) {
  const board = useBoard();
  const notice = useCompanyNotice();
  const [open, setOpen] = useState(() => window.innerWidth >= 700);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(t);
  }, []);
  if (!board) return null;

  const total = board.summary?.total ?? board.items.length;
  const by = board.summary?.byPhase ?? {};
  const done = by.DONE ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const ap = board.autopilot;
  const openDecisions = (board.decisions ?? []).filter((d) => d.status === 'open').length;
  const waiting: BoardEvent[] = board.waiting ?? [];
  const showNotice = notice && now - notice.at < 8000;

  return (
    <div
      className="absolute top-10 left-1/2 -translate-x-1/2 z-30 pixel-panel px-8 py-4 flex flex-col gap-3 max-w-[92vw]"
      data-testid="company-hud"
    >
      <div className="flex items-center gap-8 flex-wrap text-2xs leading-none">
        <button
          className="cursor-pointer text-xs"
          onClick={() => setOpen((v) => !v)}
          title="Plegar/desplegar"
        >
          {open ? '▾' : '▸'} {board.project}
        </button>
        <span
          className="w-70 h-6 border border-border bg-bg-dark"
          title={`${done} de ${total} tareas hechas`}
        >
          <span
            className="block h-full"
            style={{ width: `${pct}%`, background: PHASE_COLORS.DONE }}
          />
        </span>
        <span>
          {done}/{total} hechas
        </span>
        {(by.ACTIVE ?? 0) > 0 && (
          <span style={{ color: PHASE_COLORS.ACTIVE }}>{by.ACTIVE} en curso</span>
        )}
        {(by.AWAITING_REVIEW ?? 0) > 0 && (
          <span style={{ color: PHASE_COLORS.AWAITING_REVIEW }}>
            {by.AWAITING_REVIEW} en revisión
          </span>
        )}
        {(by.VERIFIED ?? 0) > 0 && (
          <span style={{ color: PHASE_COLORS.VERIFIED }}>{by.VERIFIED} verificadas</span>
        )}
        {ap && (
          <Button
            size="sm"
            variant={ap.enabled ? 'active' : 'default'}
            onClick={() => transport.send({ type: 'companyAutopilot', enabled: !ap.enabled })}
            title={
              ap.enabled
                ? 'Pausar el piloto automático (termina la ronda en curso)'
                : 'Activar el piloto automático'
            }
          >
            {ap.enabled ? '⏸ Piloto' : '▶ Piloto'}
          </Button>
        )}
        {ap && (
          <span className="text-text-muted">
            {AUTOPILOT_TEXT[ap.status ?? ''] ?? ap.status}
            {ap.status === 'sleeping' && ap.nextRound ? ` (${clock(ap.nextRound)})` : ''}
            {ap.enabled && !ap.running ? ' · proceso no activo' : ''}
          </span>
        )}
        {(board.decisions?.length ?? 0) > 0 && (
          <Button
            size="sm"
            variant={openDecisions ? 'accent' : 'default'}
            onClick={onOpenDecisions}
          >
            Decisiones {openDecisions ? `(${openDecisions})` : ''}
          </Button>
        )}
      </div>
      {showNotice && (
        <div className="text-2xs" style={{ color: QUOTA_COLORS.warning }}>
          {notice.text}
        </div>
      )}
      {open && board.quota && (
        <>
          <QuotaRow name="Claude" q={board.quota.claude} />
          <QuotaRow name="Codex" q={board.quota.codex} />
        </>
      )}
      {open &&
        waiting.slice(0, 3).map((e, i) => (
          <div
            key={`${e.session}-${i}`}
            className="text-2xs leading-tight overflow-hidden text-ellipsis whitespace-nowrap"
            style={{ color: QUOTA_COLORS.rejected }}
            title={e.detail}
          >
            ⏸ {e.session} · {e.detail.replace(/^Puerta de cuota: /, '')}
          </div>
        ))}
      {open && waiting.length === 0 && board.gate?.[0] && (
        <div
          className="text-2xs leading-tight overflow-hidden text-ellipsis whitespace-nowrap text-text-muted"
          title={board.gate[0].detail}
        >
          ▶ {board.gate[0].session} · {board.gate[0].detail.replace(/^Puerta de cuota: /, '')}
        </div>
      )}
    </div>
  );
}
