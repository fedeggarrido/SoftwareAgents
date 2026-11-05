import { compileAgent } from './agentCompiler.js';
import {
  RESEARCH_BUDGET_HEADROOM_FRACTION,
  RESEARCH_BYTES_PER_TOKEN,
  RESEARCH_REQUEST_MAX_BYTES,
  RESEARCH_REQUEST_OVERHEAD_TOKENS,
} from './constants.js';
import type { Executor } from './executors/executor.js';
import { researchCost, researchDeadline, type researchPolicy } from './researchPolicy.js';

/** Shared SA-112 accounting: fixed headroom, cancellation and conservative unknown cost. */
export function researchBudget(
  underlying: Executor,
  policy: ReturnType<typeof researchPolicy>,
  abort: AbortController,
  gaps: string[],
) {
  let usedTokens = 0,
    usedEstimateUsd = 0;
  let stopReason: string | undefined;
  // Keep fixed headroom from the total cap. This is an estimate, not a reservation.
  const allowance = () =>
    policy.maxCostUsd * (1 - RESEARCH_BUDGET_HEADROOM_FRACTION) - usedEstimateUsd;
  const checkCostStop = () => {
    if (usedEstimateUsd >= policy.maxCostUsd)
      stopReason ??= 'Tope estimado de coste alcanzado; informe parcial.';
    else if (allowance() <= 0)
      stopReason ??= 'Presupuesto restante sin margen de coste disponible; informe parcial.';
  };
  const executor: Executor = {
    id: underlying.id,
    start(request) {
      checkCostStop();
      if (abort.signal.aborted || usedTokens >= policy.maxTokens || stopReason) {
        stopReason ??= 'Token/cost budget exhausted.';
        throw new Error('Research budget exhausted');
      }
      const maxCostUsd = allowance();
      if (!request.agentSpec) throw new Error('Research preflight requires an AgentSpec');
      const compiled = compileAgent(
        request.agentSpec,
        request.role,
        request.taskData ?? {
          task: { key: request.taskKey, content: request.prompt },
        },
      );
      const bytes = Buffer.byteLength(compiled.systemPrompt) + Buffer.byteLength(compiled.context);
      const estimatedInputTokens =
        Math.ceil(bytes / RESEARCH_BYTES_PER_TOKEN) + RESEARCH_REQUEST_OVERHEAD_TOKENS;
      if (
        bytes > RESEARCH_REQUEST_MAX_BYTES ||
        estimatedInputTokens >= policy.maxTokens - usedTokens ||
        researchCost(estimatedInputTokens, 0) >= maxCostUsd
      ) {
        stopReason = 'Input budget exhausted in preflight; no model call launched.';
        gaps.push(
          'Omitted complete synthesis context (system prompt, output schema and all task data: plan items, diff, branch/external evidence or collected sources); input exceeds remaining tokens, estimated input cost or per-request size limit.',
        );
        throw new Error('Research input budget exhausted');
      }
      const handle = underlying.start({
        ...request,
        researchBudget: { maxCostUsd },
      });
      let accounted = false;
      const account = (reportedCost?: number) => {
        if (accounted) return;
        accounted = true;
        if (abort.signal.aborted) stopReason ??= 'Time budget exhausted.';
        if (typeof reportedCost === 'number' && Number.isFinite(reportedCost) && reportedCost >= 0)
          usedEstimateUsd += reportedCost;
        else {
          usedEstimateUsd += maxCostUsd;
          gaps.push(
            'Coste no disponible o inválido; se contabiliza toda la asignación de la llamada.',
          );
        }
        checkCostStop();
      };
      const cancel = () => handle.cancel();
      abort.signal.addEventListener('abort', cancel, { once: true });
      return {
        cancel,
        events: (async function* () {
          try {
            const iterator = handle.events[Symbol.asyncIterator]();
            for (;;) {
              const next = await researchDeadline(iterator.next(), abort.signal);
              if (next.done) break;
              const event = next.value;
              if (event.type === 'usage') {
                if (
                  ![event.inputTokens, event.outputTokens].every(
                    (n) => Number.isFinite(n) && n >= 0,
                  )
                )
                  throw new Error('Invalid research usage');
                usedTokens += event.inputTokens + event.outputTokens;
                if (usedTokens >= policy.maxTokens) {
                  stopReason = 'Token budget exhausted.';
                  abort.abort();
                }
              }
              if (event.type === 'finished') account(event.costUsd);
              yield event;
            }
          } finally {
            account();
            cancel();
            abort.signal.removeEventListener('abort', cancel);
          }
        })(),
      };
    },
  };
  return {
    executor,
    get usedTokens() {
      return usedTokens;
    },
    get usedEstimateUsd() {
      return usedEstimateUsd;
    },
    get stopReason() {
      return stopReason;
    },
  };
}
