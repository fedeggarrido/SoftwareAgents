import { createRequire } from 'module';

import { runFeatureCommand } from '../../src/commands/feature.js';
import { EXECUTOR_PROBE_CATALOG } from '../../src/executorProbes.js';
import { readyProbeFor } from '../helpers/readyProbe.js';

// Separate process with an isolated Windows home, fake CLIs and production leases.
Object.defineProperty(createRequire(process.argv[1])('os'), 'homedir', {
  value: () => process.env.HOME,
});
const [repo, fixture, log] = process.argv.slice(2);
void runFeatureCommand(['run', 'FEAT-001', '--json'], repo, console.log, {
  binaryArgs: [fixture, 'pause', log],
  probe: readyProbeFor(EXECUTOR_PROBE_CATALOG),
}).catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
