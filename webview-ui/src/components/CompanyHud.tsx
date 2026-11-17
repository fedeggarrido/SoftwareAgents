import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { PHASE_COLORS, QUOTA_COLORS } from '../constants.js';
import { backlogPulse } from '../office/backlogGroups.js';
import type { ProviderQuota } from '../office/boardStore.js';
import { useBoard, useCompanyNotice } from '../office/boardStore.js';
import { capacityHudView, capacityView, visibleProviderCounts } from '../office/capacityView.js';
import { criticalBlockers } from '../office/criticalBlockers.js';
import { decisionsHudView } from '../office/decisionsHudView.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { useExecutorStore } from '../office/executorStore.js';
import { transport } from '../transport/index.js';
import { ExecutorPanel } from './ExecutorPanel.js';
import { StatusChip as WorkStatusChip } from './StatusChip.js';
import { Button } from './ui/Button.js';

function clock(epochS: number | null | undefined): string {
  if (!epochS) return '—';
  return new Date(epochS * 1000).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
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
  const d = capacityView(q, running);
  return (
    <div className="grid grid-cols-[52px_minmax(0,1fr)] gap-x-8 text-2xs leading-tight">
      <span className="text-text-muted">{name}</span>
      <span>
        <span style={{ color: d.color }}>● {d.status}</span>
        <span className="block text-text-muted mt-2">{d.detail}</span>
        <span className="block text-text-muted mt-2">{d.provenance}</span>
        {d.windows.map((text, i) => (
          <span key={i} className="block text-text-muted mt-2">
            {text}
          </span>
        ))}
      </span>
    </div>
  );
}

const actionClass =
  'ui-info shrink-0 border border-border bg-btn-bg px-7 py-3 leading-none text-text hover:bg-btn-hover cursor-pointer';

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

function HudPulse({ phases }: { phases: readonly string[] }) {
  const pulse = backlogPulse(phases);
  return (
    <span className="hud-pulse" data-testid="hud-pulse">
      {pulse.working === 0 && pulse.needsYou === 0 && pulse.blocked === 0 ? (
        'Nadie trabajando · nada espera tu revisión'
      ) : (
        <>
          <strong>{pulse.working}</strong> trabajando · <strong>{pulse.needsYou}</strong> te
          necesitan · <strong>{pulse.blocked}</strong> bloqueadas
        </>
      )}
    </span>
  );
}

interface CompanyHudProps {
  onOpenDecisions: () => void;
  onOpenMeeting: () => void;
  meetingUnread?: boolean;
  officeState: OfficeState;
  agents: number[];
}

/** Critical blockers stay outside the collapsible project details in every HUD mode. */
export function CompanyHud(props: CompanyHudProps) {
  const board = useBoard();
  const executors = useExecutorStore();
  const [open, setOpen] = useState(false);
  const executorSection = useRef<HTMLDivElement>(null);
  const blockers = criticalBlockers(executors.state);
  const openExecutors = () => {
    flushSync(() => setOpen(true));
    executorSection.current?.focus({ preventScroll: true });
    executorSection.current?.scrollIntoView({ block: 'nearest' });
  };
  if (!board && !executors.state) return null;
  return (
    <div
      className="layer-hud pixel-panel min-w-0 p-8 flex flex-col gap-6"
      data-testid="company-hud"
    >
      {blockers.map((blocker) => (
        <div className="critical-blocker" key={blocker.id} data-testid="critical-blocker">
          <div role="status">
            <WorkStatusChip state="BLOCKED" />
            <p>{blocker.text}</p>
          </div>
          <Button type="button" onClick={openExecutors}>
            Ver ejecutores
          </Button>
        </div>
      ))}
      <div className="hud-content">
        <CompanyHudContent
          {...props}
          open={open}
          onToggle={() => setOpen((value) => !value)}
          executorPanel={
            <div
              className="hud-executors"
              ref={executorSection}
              tabIndex={-1}
              role="group"
              aria-label="Configuración de ejecutores"
            >
              <ExecutorPanel />
            </div>
          }
        />
      </div>
    </div>
  );
}

/** Project progress, autopilot, owner decisions and provider availability. */
function CompanyHudContent({
  onOpenDecisions,
  onOpenMeeting,
  meetingUnread = false,
  officeState,
  agents,
  open,
  onToggle,
  executorPanel,
}: CompanyHudProps & { open: boolean; onToggle: () => void; executorPanel: ReactNode }) {
  const board = useBoard();
  const notice = useCompanyNotice();
  const executors = useExecutorStore();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(t);
  }, []);
  // The executor state comes from the Project runtime, not the backlog mirror:
  // without a board the HUD still shows it.
  if (!board) {
    if (!executors.state) return null;
    return (
      <>
        <button
          className="min-w-0 truncate text-left text-xs cursor-pointer"
          onClick={onToggle}
          aria-expanded={open}
          title={open ? 'Ocultar detalles' : 'Ver executors del proyecto'}
        >
          {open ? '▾' : '▸'} {executors.state.projectId}
        </button>
        {open && executorPanel}
      </>
    );
  }

  const capacity = capacityHudView(board);
  const decisions = decisionsHudView(board);
  const decisionsControl = decisions.visible && (
    <button className={actionClass} onClick={onOpenDecisions} aria-label={decisions.accessibleName}>
      Decisiones <span className="ui-counter">· {decisions.open}</span>
    </button>
  );
  const meetingControl = (board.meeting || meetingUnread) && (
    <button className={actionClass} onClick={onOpenMeeting}>
      Reuniones
      {meetingUnread && (
        <span className="ml-4 text-text" role="status" aria-label="Nueva actividad">
          ●
        </span>
      )}
    </button>
  );
  const counts = visibleProviderCounts(agents);
  if (capacity.minimal) {
    return (
      <>
        <div className="flex justify-between gap-8 text-xs">
          <button
            className="min-w-0 truncate text-left cursor-pointer"
            onClick={onToggle}
            aria-expanded={open}
            title={open ? 'Ocultar detalles' : 'Ver detalles de la oficina'}
          >
            {open ? '▾' : '▸'} {board.project} {board.projectId ? `(${board.projectId})` : ''}
          </button>
          {decisionsControl}
          {meetingControl}
        </div>
        <HudPulse phases={board.items.map((item) => item.phase)} />
        {open && executorPanel}
        {open && board.quota && (
          <>
            <QuotaRow name="Claude" q={board.quota.claude} running={counts.claude} />
            <QuotaRow name="Codex" q={board.quota.codex} running={counts.codex} />
          </>
        )}
      </>
    );
  }

  const total = board.summary?.total ?? board.items.length;
  const by = board.summary?.byPhase ?? {};
  const done = by.DONE ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const ap = board.autopilot;
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
    <>
      <div className="flex items-center justify-between gap-8 min-w-0">
        <button
          className="hud-project flex min-w-0 items-center gap-5 text-left text-text cursor-pointer hover:text-accent-bright"
          onClick={onToggle}
          aria-expanded={open}
          title={open ? 'Ocultar detalles' : 'Ver detalles de la oficina'}
        >
          <span className="text-accent-bright" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="truncate">{board.project}</span>
        </button>
        <span
          className="ui-counter shrink-0 text-text-muted"
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
          <HudPulse phases={board.items.map((item) => item.phase)} />
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
          {meetingControl}
          {decisionsControl}
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
          {executorPanel}
          {board.quota && (
            <div className="flex flex-col gap-4">
              <div className="text-2xs text-text-muted">{capacity.title}</div>
              <QuotaRow name="Claude" q={board.quota.claude} running={counts.claude} />
              <QuotaRow name="Codex" q={board.quota.codex} running={counts.codex} />
            </div>
          )}
        </div>
      )}
    </>
  );
}
