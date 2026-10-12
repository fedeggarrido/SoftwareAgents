// Isolated real process, synthetic executor only. Patch before loading the bundle:
// Windows ignores HOME in os.homedir(). Never access the user's profile.
const os = require('os');
if (!process.env.HOME) throw new Error('An isolated HOME is required');
os.homedir = () => process.env.HOME;
const runtime = require(process.argv[2]);
// Launch-time availability probes (SA-090) answer as a supported, logged-in CLI;
// mirrors __tests__/helpers/readyProbe.ts without spawning anything.
const help = [
  '--output-format stream-json --strict-mcp-config --mcp-config --setting-sources',
  '--settings --session-id --permission-mode --append-system-prompt',
  '--disable-slash-commands --tools --json --sandbox --ignore-user-config',
  '--ignore-rules --output-schema',
  '  auth  Manage authentication',
  '  status  Show login status',
].join('\n');
const probe = async (_file, args) =>
  args.includes('--version')
    ? { code: 0, output: '99.0.0' }
    : args[0] === 'auth'
      ? { code: 0, output: '{"loggedIn":true}' }
      : args[0] === 'login' && args[1] === 'status'
        ? { code: 0, output: 'Logged in' }
        : { code: 0, output: help };
process.on(
  'message',
  async ({ task, repo, fake, operator, nowS, executor = 'claude', selectExecutor = false }) => {
    const logs = [];
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
        { task, brief: 'brief.md', selectExecutor },
        {
          cwd: repo,
          binaryArgs: [fake, executor, '--slot-hold'],
          log: (line) => logs.push(line),
          probe,
        },
      );
      process.send({ result, logs, exitCode: process.exitCode ?? 0 });
    } catch (error) {
      process.send({ error: error.message, logs });
      process.exitCode = 1;
    } finally {
      if (task !== 'reserve-slot') process.disconnect();
    }
  },
);
process.send({ ready: true });
