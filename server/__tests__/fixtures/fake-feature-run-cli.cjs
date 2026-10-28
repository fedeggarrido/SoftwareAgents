// Dispatcher for the real pipeline: fake CLIs only, with real Git/verifiers/WorkStore.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const [scenario, log, ...args] = process.argv.slice(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  const executor = prompt.includes('UNTRUSTED_CONTEXT_JSON\n') ? 'codex' : 'claude';
  const context = JSON.parse(
    executor === 'codex' ? prompt.split('UNTRUSTED_CONTEXT_JSON\n')[1] : prompt,
  );
  const data = JSON.parse(context.task.brief);
  const role = data.commands
    ? 'qa'
    : data.reviewRef
      ? 'reviewer'
      : data.task
        ? 'developer'
        : data.approvedSpec
          ? 'architect'
          : 'requirements';
  const rows = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  fs.appendFileSync(
    log,
    JSON.stringify({ role, task: data.task?.key, data, cwd: process.cwd() }) + '\n',
  );
  if (role === 'developer') {
    if (scenario === 'pause' && !rows.some((r) => r.role === 'developer')) {
      fs.writeFileSync(log + '.running', String(process.pid));
      // A live fake child allows tests to kill the orchestrator while a real lease is RUNNING.
      setInterval(() => {
        if (fs.existsSync(log + '.stop')) process.exit(0);
      }, 50);
      return;
    }
    const n = Number(data.task.key.slice(-1));
    if (data.task.type === 'doc') {
      fs.mkdirSync('docs', { recursive: true });
      if (scenario === 'doc-delete') fs.unlinkSync('docs/guide.md');
      else fs.writeFileSync('docs/guide.md', '# Guide\n\nDocumented behavior.\n');
    } else {
      fs.mkdirSync('server/src', { recursive: true });
      fs.mkdirSync('server/__tests__', { recursive: true });
      if (n < 3) fs.writeFileSync(`server/src/step${n}.ts`, `export const step${n} = ${n};\n`);
      const previous = n === 1 ? 1 : n - 1;
      const rework =
        data.reviewFindings?.length || data.qaDefects?.length
          ? `it('fixes rework', () => expect(step${previous}).toBe(${previous}));\n`
          : '';
      fs.writeFileSync(
        `server/__tests__/step${n}.test.ts`,
        `import { expect, it } from 'vitest';\n\nimport { step${previous} } from '../src/step${previous}';\n\nit('step ${n} sees its dependency', () => expect(step${previous}).toBe(${previous}));\n${rework}`,
      );
      if (
        scenario === 'always-fail' ||
        (scenario === 'retry' && !rows.some((r) => r.role === 'developer'))
      )
        fs.unlinkSync(`server/__tests__/step${n}.test.ts`);
    }
    if (executor === 'claude') {
      console.log(
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: 'fake-feature-developer',
          tools: ['Read', 'Write'],
        }),
      );
      console.log(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'Implemented',
          is_error: false,
        }),
      );
    } else {
      require('./codex-rollout.cjs')('fake-feature-developer');
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-feature-developer' }));
      console.log(JSON.stringify({ type: 'turn.started' }));
      console.log(
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
      );
    }
    return;
  }
  const mode =
    role === 'architect'
      ? scenario.startsWith('doc')
        ? 'orchestrator-doc'
        : ['rework', 'defect', 'single', 'retry', 'always-fail'].includes(scenario)
          ? 'orchestrator-single'
          : 'orchestrator-chain'
      : role === 'reviewer'
        ? scenario === 'rework' && !rows.some((r) => r.role === 'reviewer')
          ? 'reject'
          : 'approve'
        : role === 'qa'
          ? scenario === 'defect' && !rows.some((r) => r.role === 'qa')
            ? 'fail'
            : 'pass'
          : 'valid';
  process.stdout.write(
    execFileSync(
      process.execPath,
      [path.join(__dirname, `fake-${role}-cli.cjs`), executor, mode, log + '.details', ...args],
      { input: prompt, encoding: 'utf8', windowsHide: true },
    ),
  );
});
