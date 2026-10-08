const os = require('os');
const fs = require('fs');
const path = require('path');
if (!process.env.HOME || process.env.HOME !== process.env.USERPROFILE)
  throw new Error('Isolated profile required');
os.homedir = () => process.env.HOME;
const runtime = require(process.argv[2]);
const phase = process.argv[3];
const slot = runtime.withExecutorAdmission('codex', 'crash-launch', (owner) =>
  runtime.acquireExecutorSlot('codex', 1, owner),
);
slot.markLaunching('registered_wrapper');
runtime.spawnRegisteredProcess(
  process.execPath,
  [
    '-e',
    `
const fs = require('fs');
fs.writeFileSync(process.env.HOME + '/launched', String(process.pid));
const timer = setInterval(() => { if (fs.existsSync(process.env.HOME + '/finish')) { clearInterval(timer); } }, 10);
`,
  ],
  process.env.HOME,
  (pid) => {
    if (phase === 'registered') slot.setExecutionProcess(pid);
    process.send({ phase, supervisor: pid });
    if (phase !== 'launched') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
    else slot.setExecutionProcess(pid);
  },
);
