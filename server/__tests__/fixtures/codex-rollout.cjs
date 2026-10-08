// Synthetic rollouts must only use a test-provided root, never the user's home.
const fs = require('fs');
const path = require('path');
module.exports = function writeRollout(sessionId) {
  const root =
    process.env.FAKE_CODEX_SESSIONS ||
    (process.env.CODEX_HOME && path.join(process.env.CODEX_HOME, 'sessions'));
  if (!root) throw new Error('Test rollout root required');
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const day = path.join(
    root,
    String(now.getFullYear()),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  );
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, `rollout-${sessionId}.jsonl`);
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }) + '\n',
  );
  return file;
};
