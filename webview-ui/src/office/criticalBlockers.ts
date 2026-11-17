import type { ExecutorState } from '../../../core/src/messages.js';

export interface CriticalBlocker {
  id: 'recovery_required' | 'invalid' | 'executors_disabled';
  text: string;
}

/** Project state only; an empty catalog does not prove that every executor is off. */
export function criticalBlockers(state: ExecutorState | null): CriticalBlocker[] {
  if (!state) return [];
  switch (state.configurationStatus) {
    case 'recovery_required':
      return [
        {
          id: 'recovery_required',
          text: 'Un cambio de disponibilidad no tiene resultado verificado: lanzamientos bloqueados hasta «pixel-agents executors recover».',
        },
      ];
    case 'invalid':
      return [
        {
          id: 'invalid',
          text: 'Configuración del operador no disponible o inválida: no se lanza nada.',
        },
      ];
    case 'ready':
    case 'pending':
      return state.executors.length > 0 && state.executors.every((executor) => !executor.enabled)
        ? [
            {
              id: 'executors_disabled',
              text: 'Nuevas tareas bloqueadas: todos los ejecutores están desactivados.',
            },
          ]
        : [];
  }
}
