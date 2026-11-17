import { describe, expect, it } from 'vitest';

import { criticalBlockers } from '../src/office/criticalBlockers.js';
import { executorSnapshot } from './fixtures/executorState.js';

describe('critical blockers', () => {
  it('does not infer disabled executors from missing state or an empty catalog', () => {
    expect(criticalBlockers(null)).toEqual([]);
    expect(criticalBlockers(executorSnapshot({ executors: [] }))).toEqual([]);
  });

  it.each(['ready', 'pending'] as const)(
    'warns when every executor is off (%s)',
    (configurationStatus) => {
      expect(criticalBlockers(executorSnapshot({ configurationStatus }))).toEqual([
        {
          id: 'executors_disabled',
          text: 'Nuevas tareas bloqueadas: todos los ejecutores están desactivados.',
        },
      ]);
    },
  );

  it.each(['claude', 'codex'])(
    'clears the all-off blocker when %s is enabled, regardless of eligibility',
    (executorId) => {
      const state = executorSnapshot();
      state.executors = state.executors.map((executor) => ({
        ...executor,
        enabled: executor.executorId === executorId,
      }));
      expect(criticalBlockers(state)).toEqual([]);
    },
  );

  it.each(['invalid', 'recovery_required'] as const)(
    'prioritizes %s over disabled executors',
    (configurationStatus) => {
      const state = executorSnapshot({ configurationStatus });
      expect(criticalBlockers(state)).toHaveLength(1);
      expect(criticalBlockers(state)[0].id).toBe(configurationStatus);
      expect(criticalBlockers(state)[0].text).toMatch(/no se lanza nada|executors recover/);
    },
  );
});
