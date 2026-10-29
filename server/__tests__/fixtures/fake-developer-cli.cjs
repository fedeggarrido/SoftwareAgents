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
  const {
    reviewFindings = [],
    qaDefects = [],
    reworkAttempt,
    guardCorrection,
    task,
  } = JSON.parse(context.task.brief);
  const author = ['qa', 'test', 'qa-author'].includes(task.agentRole);
  const findings = [...reviewFindings, ...qaDefects];
  if (!author || mode === 'product')
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
    if (mode === 'downstream')
      fs.appendFileSync(
        'server/__tests__/audit.test.ts',
        "it('covers downstream AC-001', () => expect(implemented).toBe(true));\n",
      );
    if (author) {
      fs.mkdirSync('server/__tests__/helpers', { recursive: true });
      fs.writeFileSync('server/__tests__/helpers/answer.ts', 'export const answer = 42;\n');
      fs.writeFileSync(
        'server/__tests__/audit.test.ts',
        `import { expect, it } from 'vitest';

import { answer } from './helpers/answer';

it('implements AC-001', () => expect(answer).toBe(${mode === 'bad-test' ? 0 : 42}));\n`,
      );
      if (task.changeZones.includes('e2e/**')) {
        fs.rmSync('server/__tests__', { recursive: true });
        fs.mkdirSync('e2e/tests/standalone', { recursive: true });
        fs.writeFileSync(
          'e2e/tests/standalone/audit.spec.ts',
          `import { expect, test } from '@playwright/test';

test('audit is visible', async ({ page }) => {
  await page.setContent('<h1>Audit</h1>');
  await expect(page.getByRole('heading')).toHaveText('Audit');
});\n`,
        );
      }
    }
    if (mode === 'bad-format')
      fs.appendFileSync('server/__tests__/audit.test.ts', 'const brokenFormat=  1\n');
    if (mode === 'bad-imports')
      fs.writeFileSync(
        'server/__tests__/audit.test.ts',
        fs
          .readFileSync('server/__tests__/audit.test.ts', 'utf8')
          .replace('{ expect, it }', '{ it, expect }'),
      );
    if (mode === 'bad-lint') fs.appendFileSync('server/__tests__/audit.test.ts', 'debugger;\n');
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
  if (mode === 'misplaced' || mode === 'misplaced-always') {
    if (!guardCorrection || mode === 'misplaced-always')
      fs.renameSync('server/__tests__/audit.test.ts', 'server/src/audit.test.ts');
    else if (fs.existsSync('server/src/audit.test.ts')) fs.unlinkSync('server/src/audit.test.ts');
  }
  if (mode === 'nested-git') {
    fs.mkdirSync('scratch/.git', { recursive: true });
  }
  if (mode.startsWith('core-')) {
    fs.unlinkSync('server/src/audit.ts');
    fs.unlinkSync('server/__tests__/audit.test.ts');
    fs.mkdirSync('core/src', { recursive: true });
    fs.writeFileSync('core/src/messages.ts', 'export const implemented = true;\n');
    const test =
      mode === 'core-outside'
        ? 'core/src/messages.test.ts'
        : 'server/__tests__/core/messages.test.ts';
    fs.mkdirSync(require('path').dirname(test), { recursive: true });
    fs.writeFileSync(
      test,
      "import { expect, it } from 'vitest';\n\nimport { implemented } from '../../../core/src/messages';\n\nit('implements AC-001', () => expect(implemented).toBe(true));\n",
    );
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
    if (mode === 'shell-denied' && !guardCorrection)
      emit({
        type: 'item.started',
        item: {
          id: 'shell-denied',
          type: 'command_execution',
          command: 'Set-Content test.ts ".git"',
        },
      });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  }
});
