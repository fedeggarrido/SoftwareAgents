import type { EXECUTOR_PROBE_CATALOG, ProbeRunner } from '../../src/executorProbes.js';

/**
 * Synthetic probe answers: a supported, logged-in CLI. Spawns nothing. Takes the
 * catalog as an argument so a vi.mock factory of executorProbes can build it
 * without importing the module it is mocking.
 */
export function readyProbeFor(catalog: typeof EXECUTOR_PROBE_CATALOG): ProbeRunner {
  const help = [
    ...new Set(Object.values(catalog).flatMap((c) => c.requiredFlags)),
    '',
    'Commands:',
    '  auth  Manage authentication',
    '  status  Show login status',
  ].join('\n');
  return async (_file, args) => {
    if (args.includes('--version')) return { code: 0, output: '99.0.0' };
    if (args[0] === 'auth') return { code: 0, output: '{"loggedIn":true}' };
    if (args[0] === 'login' && args[1] === 'status') return { code: 0, output: 'Logged in' };
    return { code: 0, output: help };
  };
}
