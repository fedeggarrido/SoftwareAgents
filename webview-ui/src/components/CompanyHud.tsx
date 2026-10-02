import { useEffect, useState } from 'react';

import { PHASE_COLORS, QUOTA_COLORS } from '../constants.js';
import type { ProviderQuota } from '../office/boardStore.js';
import { useBoard, useCompanyNotice } from '../office/boardStore.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { getProviderLabel } from '../office/toolUtils.js';
import { transport } from '../transport/index.js';

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

export function QuotaRow({
  name,
  q,
  running,
}: {
  name: string;
  q: ProviderQuota;
  running: number;
}) {
  const d = describe(q);
  return (
    <div className="grid grid-cols-[52px_minmax(0,1fr)] gap-x-8 text-2xs leading-tight">
      <span className="text-text-muted">{name}</span>
      <span>
        <span style={{ color: d.color }}>● {d.status}</span>
        <span className="block text-text-muted mt-2">{d.detail}</span>
        <span className="block text-text-muted mt-2">
          {running} agentes en marcha · Fuente: {q.capacity?.source ?? 'estimated'} · Confianza:{' '}
          {q.capacity?.confidence ?? 'unknown'}
        </span>
        {q.capacity?.windows.map((w, i) => (
          <span key={i} className="block text-text-muted mt-2">
            {w.kind === 'five_hour' ? '5 horas' : w.kind === 'weekly' ? 'Semanal' : 'Otra ventana'}:{' '}
            {w.usedRatio === null ? 'uso desconocido' : Math.round(w.usedRatio * 100) + ' % usado'}{' '}
            · Reset:{' '}
            {w.resetsAt === null
              ? '—'
              : new Date(w.resetsAt * 1000).toLocaleString('es-ES', {
                  day: '2-digit',
                  month: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
          </span>
        ))}
      </span>
    </div>
  );
}

const actionClass =
  'shrink-0 border border-border bg-btn-bg px-7 py-3 text-2xs leading-none text-text hover:bg-btn-hover cursor-pointer';

function StatusChip({ text, color }: { text: string; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-4 whitespace-nowrap border border-border bg-bg-dark px-5 py-2 text-2xs leading-none"
      style={{ color }}
    >
      <span className="text-[10px]" aria-hidden="true">
        ●
      </span>
      {text}
    </span>
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
  const pilotStatus = ap ? (AUTOPILOT_TEXT[ap.status ?? ''] ?? ap.status ?? 'sin estado') : null;

  return (
    <div
      className="absolute top-10 left-1/2 -translate-x-1/2 z-30 pixel-panel w-[min(600px,calc(100vw-120px))] min-w-0 p-8 flex flex-col gap-6"
      data-testid="company-hud"
    >
      <div className="flex items-center justify-between gap-8 min-w-0">
        <button
          className="flex min-w-0 items-center gap-5 text-left text-xs text-text cursor-pointer hover:text-accent-bright"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? 'Ocultar detalles' : 'Ver detalles de la oficina'}
        >
          <span className="text-accent-bright" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="truncate">{board.project}</span>
        </button>
        <span
          className="shrink-0 text-2xs text-text-muted"
          title={`${done} de ${total} tareas hechas`}
        >
          <span className="text-text">{done}</span> de {total} hechas
        </span>
      </div>
      <div
        className="h-4 w-full overflow-hidden border border-border bg-bg-dark"
        aria-label={`${pct} % completado`}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full" style={{ width: `${pct}%`, background: PHASE_COLORS.DONE }} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-10 gap-y-5">
        <div className="flex min-w-0 flex-wrap items-center gap-4">
          {(by.ACTIVE ?? 0) > 0 && (
            <StatusChip text={`${by.ACTIVE} en curso`} color={PHASE_COLORS.ACTIVE} />
          )}
          {(by.AWAITING_REVIEW ?? 0) > 0 && (
            <StatusChip
              text={`${by.AWAITING_REVIEW} en revisión`}
              color={PHASE_COLORS.AWAITING_REVIEW}
            />
          )}
          {board.manager?.stale && (
            <StatusChip text="Manager sin latido" color={PHASE_COLORS.BLOCKED} />
          )}
          {ap && (
            <StatusChip
              text={`Piloto ${pilotStatus}`}
              color={ap.enabled ? PHASE_COLORS.ACTIVE : QUOTA_COLORS.unknown}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <button className={actionClass} onClick={onOpenBacklog} title="Ver todas las tareas">
            Tareas
          </button>
          {(board.decisions?.length ?? 0) > 0 && (
            <button className={actionClass} onClick={onOpenDecisions}>
              Decisiones{openDecisions ? ` ${openDecisions}` : ''}
            </button>
          )}
          {ap && (
            <button
              className={`${actionClass} ${ap.enabled ? 'border-accent bg-active-bg' : ''}`}
              onClick={() => transport.send({ type: 'companyAutopilot', enabled: !ap.enabled })}
              title={ap.enabled ? 'Pausar el piloto automático' : 'Activar el piloto automático'}
              aria-pressed={ap.enabled}
            >
              {ap.enabled ? '⏸ Piloto' : '▶ Piloto'}
            </button>
          )}
        </div>
      </div>
      {showNotice && (
        <div className="text-2xs" style={{ color: QUOTA_COLORS.warning }}>
          {notice.text}
        </div>
      )}
      {open && (
        <div className="flex flex-col gap-5 border-t border-border pt-6">
          <div className="flex flex-wrap gap-x-10 gap-y-3 text-2xs text-text-muted">
            {working > 0 && <span>{working} trabajando ahora</span>}
            {withoutSignal > 0 && <span>{withoutSignal} sin actividad visible</span>}
            {(by.VERIFIED ?? 0) > 0 && <span>{by.VERIFIED} verificadas</span>}
            {ap?.status === 'sleeping' && ap.nextRound && (
              <span>Próxima ronda {clock(ap.nextRound)}</span>
            )}
            {ap?.enabled && !ap.running && <span>Proceso del piloto no activo</span>}
          </div>
          {board.quota && (
            <div className="flex flex-col gap-4">
              <div className="text-2xs text-text-muted">Capacidad observada</div>
              <QuotaRow
                name="Claude"
                q={board.quota.claude}
                running={
                  [...officeState.characters.values()].filter(
                    (c) => c.isActive && c.id > 0 && getProviderLabel(c.id) === 'Claude',
                  ).length
                }
              />
              <QuotaRow
                name="Codex"
                q={board.quota.codex}
                running={
                  [...officeState.characters.values()].filter(
                    (c) => c.isActive && c.id > 0 && getProviderLabel(c.id).startsWith('Codex'),
                  ).length
                }
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
