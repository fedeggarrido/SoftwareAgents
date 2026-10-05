// Isolated real process, synthetic executor only. Patch before loading the bundle:
// Windows ignores HOME in os.homedir(). Never access the user's profile.
const os = require('os');
if (!process.env.HOME) throw new Error('An isolated HOME is required');
os.homedir = () => process.env.HOME;
const runtime = require(process.argv[2]);
process.on('message', async ({ task, repo, fake, operator, nowS }) => {
  try {
    if (task === 'read-capacity') {
      process.send({ snapshot: runtime.readSelectionSnapshot(operator, nowS) });
      return;
    }
    if (task === 'reserve-slot') {
      runtime.withExecutorAdmission('codex', 'crashed-execution', (owner) => {
        runtime.acquireExecutorSlot('codex', 1, owner);
      });
      process.send({ reserved: true });
      return;
    }
    const result = await runtime.runWorker(
      { task, brief: 'brief.md' },
      {
        cwd: repo,
        binaryArgs: [fake, 'claude', '--slot-hold'],
        log: () => {},
      },
    );
    process.send({ result, exitCode: process.exitCode ?? 0 });
  } catch (error) {
    process.send({ error: error.message });
    process.exitCode = 1;
  } finally {
    if (task !== 'reserve-slot') process.disconnect();
  }
});
process.send({ ready: true });
