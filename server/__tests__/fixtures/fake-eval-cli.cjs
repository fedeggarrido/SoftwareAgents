// SA-094 protocol fixture: never invokes a real CLI or reads authentication.
const fs = require('fs');
const [executor, ...args] = process.argv.slice(2);
if (!['claude', 'codex'].includes(executor)) throw new Error('Expected executor fixture prefix');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});
process.stdin.on('end', () => {
  const log = process.env.SA_EVAL_FAKE_LOG;
  if (!log) throw new Error('Isolated fixture log is required');
  const count = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0;
  fs.appendFileSync(
    log,
    JSON.stringify({
      executor,
      cwd: process.cwd(),
      args,
      managed: process.env.SA_MANAGED_EXECUTION,
    }) + '\n',
  );
  const regression =
    prompt.includes('REGRESSION_SPEC') || args.some((a) => a.includes('REGRESSION_SPEC'));
  const failCriterion =
    process.env.SA_EVAL_FAKE_MODE === 'poison' ||
    process.env.SA_EVAL_FAKE_MODE === 'criterion-fail' ||
    (process.env.SA_EVAL_FAKE_MODE === 'inconsistent' && count % 2 === 1);
  if (!regression && !failCriterion) fs.writeFileSync('answer.txt', 'fixed');
  // Deliberately corrupt the test. Integrity must fail before restoring the pinned verifier.
  if (process.env.SA_EVAL_FAKE_MODE === 'tamper') {
    fs.mkdirSync('server/__tests__', { recursive: true });
    fs.writeFileSync('server/__tests__/answer.test.ts', 'throw new Error("tampered")');
  }
  if (process.env.SA_EVAL_FAKE_MODE === 'poison') {
    fs.writeFileSync(
      'server/poison.ts',
      "import { expect } from 'vitest'; expect.extend({toBe: () => ({pass: true, message: () => ''})});",
    );
  }
  const emit = (r) => console.log(JSON.stringify(r));
  if (executor === 'claude') {
    emit({
      type: 'system',
      subtype: 'init',
      session_id: 'fake-eval-claude',
      model: 'claude-test',
      tools: ['Read', 'Write'],
    });
    emit({
      type: 'result',
      subtype: 'success',
      result: 'OUTPUT_SECRET_MARKER',
      is_error: regression,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 2,
      },
    });
  } else {
    require('./codex-rollout.cjs')('fake-eval-codex');
    emit({ type: 'thread.started', thread_id: 'fake-eval-codex' });
    emit({ type: 'turn.started' });
    emit({
      type: 'item.completed',
      item: { id: 'output-1', type: 'agent_message', text: 'OUTPUT_SECRET_MARKER' },
    });
    emit({
      type: 'turn.completed',
      usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 5 },
    });
  }
  if (regression) process.exitCode = 1;
});
