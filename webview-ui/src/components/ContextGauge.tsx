import {
  CONTEXT_CRITICAL_THRESHOLD,
  CONTEXT_DANGER_THRESHOLD,
  CONTEXT_GAUGE_BG,
  CONTEXT_GAUGE_COLOR_CRITICAL,
  CONTEXT_GAUGE_COLOR_DANGER,
  CONTEXT_GAUGE_COLOR_OK,
  CONTEXT_GAUGE_COLOR_WARN,
  CONTEXT_GAUGE_HEIGHT_PX,
  CONTEXT_GAUGE_WIDTH_PX,
  CONTEXT_WARN_THRESHOLD,
} from '../constants.js';

export function ContextGauge({ used, limit }: { used: number; limit: number }) {
  const ratio = used / limit;
  const color =
    ratio >= CONTEXT_CRITICAL_THRESHOLD
      ? CONTEXT_GAUGE_COLOR_CRITICAL
      : ratio >= CONTEXT_DANGER_THRESHOLD
        ? CONTEXT_GAUGE_COLOR_DANGER
        : ratio >= CONTEXT_WARN_THRESHOLD
          ? CONTEXT_GAUGE_COLOR_WARN
          : CONTEXT_GAUGE_COLOR_OK;
  const percentage = Math.round(ratio * 100);
  return (
    <div
      role="meter"
      aria-label="Contexto usado"
      aria-valuenow={Math.min(percentage, 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${percentage}% del contexto usado`}
      title={`${percentage}% del contexto usado (${used.toLocaleString('es')} de ${limit.toLocaleString('es')} tokens)`}
      style={{
        width: CONTEXT_GAUGE_WIDTH_PX,
        height: CONTEXT_GAUGE_HEIGHT_PX,
        background: CONTEXT_GAUGE_BG,
      }}
      data-testid="context-gauge"
      data-context-pct={percentage}
    >
      <div style={{ width: `${Math.min(ratio * 100, 100)}%`, height: '100%', background: color }} />
    </div>
  );
}
