// Protocol fixture only. No real CLIs or credentials.
const fs = require('fs');
const [executor, mode, log, ...args] = process.argv.slice(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  const context = JSON.parse(
    executor === 'codex' ? prompt.split('UNTRUSTED_CONTEXT_JSON\n')[1] : prompt,
  );
  const data = JSON.parse(context.task.brief);
  fs.appendFileSync(log, JSON.stringify({ args, data, cwd: process.cwd() }) + '\n');
  const report = {
    verdict: mode === 'reject' ? 'request_changes' : 'approve',
    findings:
      mode === 'reject'
        ? [
            {
              severity: 'major',
              file: 'server/src/audit.ts',
              line: 1,
              summary: 'Missing pagination',
              suggestion: 'Add bounded pagination',
            },
          ]
        : [],
    acCoverage: [{ ac: 'AC-001', status: mode === 'reject' ? 'partial' : 'covered' }],
  };
  if (mode === 'invalid' || (mode === 'repair' && !data.validationErrors.length))
    report.verdict = 'invalid';
  if (mode === 'outside') fs.writeFileSync('outside.txt', 'unauthorized');
  if (mode === 'changed-sha')
    require('child_process').execFileSync(
      'git',
      ['-c', 'core.hooksPath=', 'commit', '--allow-empty', '-m', 'moved'],
      { windowsHide: true },
    );
  const output = '```json\n' + JSON.stringify(report) + '\n```';
  const emit = (value) => console.log(JSON.stringify(value));
  if (executor === 'claude') {
    emit({ type: 'system', subtype: 'init', session_id: 'fake-reviewer', tools: ['Read'] });
    emit({ type: 'result', subtype: 'success', result: output, is_error: false });
  } else {
    require('./codex-rollout.cjs')('fake-reviewer-codex');
    emit({ type: 'thread.started', thread_id: 'fake-reviewer-codex' });
    emit({ type: 'turn.started' });
    emit({ type: 'item.completed', item: { id: 'output', type: 'agent_message', text: output } });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  }
});
