import { useEffect, useState } from 'react';

import { PHASE_COLORS, QUOTA_COLORS } from '../constants.js';
import type { ProviderQuota } from '../office/boardStore.js';
import { useBoard, useCompanyNotice } from '../office/boardStore.js';
import type { OfficeState } from '../office/engine/officeState.js';
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

/** Keep the status readable without implying an exact value when none was reported. */
function describe(q: ProviderQuota): { status: string; detail: string; color: string } {
  const weekly = q.weekly?.usedPercent;
  const usage = q.usedPercent === null ? 'Menos del 90 % usado' : `${q.usedPercent} % usado`;
  const weeklyDetail = weekly === null || weekly === undefined ? '' : ` · ${weekly} % esta semana`;
  const resetAt =
    weekly !== null && weekly !== undefined && weekly >= 100 ? q.weekly?.resetsAt : q.resetsAt;
  const resetDetail = resetAt ? ` · se renueva a las ${clock(resetAt)}` : '';
  switch (q.status) {
    case 'rejected':
      return {
        status: 'Sin cuota',
        detail: `${weekly !== null && weekly !== undefined && weekly >= 100 ? 'Límite semanal alcanzado' : 'Cuota agotada'}${resetDetail}`,
        color: QUOTA_COLORS.rejected,
      };
    case 'warning':
      return {
        status: 'Cerca del límite',
        detail: `${q.usedPercent === null ? 'Al menos 90 % usado' : `${q.usedPercent} % usado`}${weeklyDetail}${resetDetail}`,
        color: QUOTA_COLORS.warning,
      };
    case 'allowed':
      return {
        status: 'Disponible',
        detail: `${usage}${weeklyDetail}`,
        color: QUOTA_COLORS.allowed,
      };
    case 'reset':
      return {
        status: 'Actualizando',
        detail: 'La cuota se renovó; falta una nueva lectura',
        color: QUOTA_COLORS.unknown,
      };
    default:
      return {
        status: 'Sin datos',
        detail: 'Aún no hay una lectura de cuota',
        color: QUOTA_COLORS.unknown,
      };
  }
}

function QuotaRow({ name, q }: { name: string; q: ProviderQuota }) {
  const d = describe(q);
  return (
    <div className="grid grid-cols-[52px_160px_minmax(180px,1fr)] items-baseline gap-x-8 text-2xs leading-tight">
      <span className="text-text">{name}</span>
      <span style={{ color: d.color }}>● {d.status}</span>
      <span className="text-text-muted">{d.detail}</span>
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
  onOpenBacklog: () => void;
  officeState: OfficeState;
}

/** Project progress, autopilot, owner decisions and provider availability. */
export function CompanyHud({ onOpenDecisions, onOpenBacklog, officeState }: CompanyHudProps) {
  const board = useBoard();
  const notice = useCompanyNotice();
  const [open, setOpen] = useState(false);
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
  const showNotice = notice && now - notice.at < 8000;
  const active = board.items.filter((i) => i.owner?.state === 'active');
  const working = active.filter((i) =>
    i.agentIds.some((id) => officeState.characters.get(id)?.isActive),
  ).length;
  const withoutSignal = active.filter(
    (i) => i.owner?.stale || !i.agentIds.some((id) => officeState.characters.get(id)?.isActive),
  ).length;

  return (
    <div
      className="absolute top-10 left-1/2 -translate-x-1/2 z-30 pixel-panel px-8 py-4 flex flex-col gap-3 w-max max-w-[92vw]"
      data-testid="company-hud"
    >
      <div className="flex items-center gap-8 overflow-x-auto whitespace-nowrap text-2xs leading-none">
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
        <Button
          size="sm"
          onClick={onOpenBacklog}
          title="Ver el estado y la actividad de cada tarea"
        >
          Tareas
        </Button>
        {(by.ACTIVE ?? 0) > 0 && (
          <span style={{ color: PHASE_COLORS.ACTIVE }}>{by.ACTIVE} en curso</span>
        )}
        {working > 0 && (
          <span style={{ color: PHASE_COLORS.ACTIVE }}>{working} trabajando ahora</span>
        )}
        {withoutSignal > 0 && (
          <span
            className="text-text-muted"
            title="Reserva activa sin actividad visible en la oficina"
          >
            {withoutSignal} sin actividad visible
          </span>
        )}
        {(by.AWAITING_REVIEW ?? 0) > 0 && (
          <span style={{ color: PHASE_COLORS.AWAITING_REVIEW }}>
            {by.AWAITING_REVIEW} en revisión
          </span>
        )}
        {(by.VERIFIED ?? 0) > 0 && (
          <span style={{ color: PHASE_COLORS.VERIFIED }}>{by.VERIFIED} verificadas</span>
        )}
        {board.manager?.stale && (
          <span
            style={{ color: PHASE_COLORS.BLOCKED }}
            title="La reserva del manager sigue activa, pero no recibe latidos"
          >
            Manager sin latido
          </span>
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
        <div className="flex flex-col gap-4 border-t border-border pt-5">
          <div className="text-2xs text-text-muted">Cuota para iniciar agentes</div>
          <QuotaRow name="Claude" q={board.quota.claude} />
          <QuotaRow name="Codex" q={board.quota.codex} />
        </div>
      )}
    </div>
  );
}
