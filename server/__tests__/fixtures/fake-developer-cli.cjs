// Protocol fixture: no real executor, credentials or dependency installation.
const fs = require('fs');
const [executor, mode, log, ...args] = process.argv.slice(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  const context = JSON.parse(
    executor === 'codex' ? prompt.split('UNTRUSTED_CONTEXT_JSON\n')[1] : prompt,
  );
  fs.appendFileSync(log, JSON.stringify({ args, context, cwd: process.cwd() }) + '\n');
  fs.mkdirSync('server/src', { recursive: true });
  const { reviewFindings = [], qaDefects = [], reworkAttempt } = JSON.parse(context.task.brief);
  const findings = [...reviewFindings, ...qaDefects];
  fs.writeFileSync(
    'server/src/audit.ts',
    `export const implemented = true;\n${findings?.length ? `// Reworked ${reworkAttempt}: bounded pagination\n` : ''}`,
  );
  if (mode !== 'no-test') {
    fs.mkdirSync('server/__tests__', { recursive: true });
    fs.writeFileSync(
      'server/__tests__/audit.test.ts',
      `import { expect, it } from 'vitest';
import { implemented } from '../src/audit';
it('implements AC-001', () => expect(implemented).toBe(${mode === 'bad-test' ? 'false' : 'true'}));\n`,
    );
    if (findings?.length)
      fs.appendFileSync(
        'server/__tests__/audit.test.ts',
        `it('addresses reviewer pagination ${reworkAttempt}', () => expect(implemented).toBe(true));\n`,
      );
    if (mode === 'empty-test')
      fs.writeFileSync(
        'server/__tests__/audit.test.ts',
        "import { it } from 'vitest'; it('empty', () => {});\n",
      );
    if (mode === 'unexecuted-assertion')
      fs.writeFileSync(
        'server/__tests__/audit.test.ts',
        "import { it, expect } from 'vitest'; it('unexecuted assertion', () => { if (false) expect(true).toBe(true); });\n",
      );
    if (mode === 'skip-suite')
      fs.writeFileSync(
        'server/__tests__/audit.test.ts',
        "import { it, expect, describe } from 'vitest'; describe.skip('skip', () => { it('test', () => expect(true).toBe(true)); });\n",
      );
  }
  if (mode === 'outside') {
    fs.writeFileSync('outside.txt', 'outside changeZones');
    fs.writeFileSync('server/__tests__/foreign.test.ts', 'outside changeZones');
  }
  const emit = (value) => console.log(JSON.stringify(value));
  if (executor === 'claude') {
    emit({
      type: 'system',
      subtype: 'init',
      session_id: 'fake-developer',
      tools: ['Read', 'Write'],
    });
    emit({ type: 'result', subtype: 'success', result: 'AC-001 implemented', is_error: false });
  } else {
    require('./codex-rollout.cjs')('fake-developer-codex');
    emit({ type: 'thread.started', thread_id: 'fake-developer-codex' });
    emit({ type: 'turn.started' });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  }
});
