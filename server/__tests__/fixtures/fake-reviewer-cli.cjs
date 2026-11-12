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
  fs.appendFileSync(
    log,
    JSON.stringify({ args, data, cwd: process.cwd(), configDir: process.env.CLAUDE_CONFIG_DIR }) +
      '\n',
  );
  const report = {
    verdict: mode === 'reject' ? 'request_changes' : 'approve',
    findings:
      mode === 'reject'
        ? [
            {
              severity: 'major',
              file: data.files.includes('server/src/audit.ts')
                ? 'server/src/audit.ts'
                : data.files[0],
              line: 1,
              evidence:
                'Request audit with 10001 rows: returns every row instead of a bounded page',
              summary: 'Missing pagination',
              suggestion: 'Add bounded pagination',
            },
          ]
        : [],
    acCoverage: [{ ac: 'AC-001', status: mode === 'reject' ? 'partial' : 'covered' }],
  };
  if (mode === 'two-pass' && data.reviewPass === 'quality_structure') {
    report.verdict = 'request_changes';
    report.findings = [
      {
        severity: 'major',
        category: 'types',
        file: data.files[0],
        line: 1,
        evidence: 'The new return value can be undefined for an empty input.',
        summary: 'types: incomplete return contract',
        suggestion: 'Handle empty input.',
      },
    ];
  }
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
  if (
    mode.startsWith('fail-') ||
    (mode === 'second-quota' && data.reviewPass === 'quality_structure')
  ) {
    const reason =
      {
        'fail-oauth': 'another Claude Code process is refreshing it',
        'fail-auth': 'not logged in',
        'fail-spawn': 'spawn ENOENT',
        'fail-timeout': 'timeout',
        'fail-quota': 'usage limit reached',
      }[mode] ?? 'usage limit reached';
    if (mode === 'fail-quota' || mode === 'second-quota')
      emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } });
    emit({ type: 'result', subtype: 'error', result: reason + ' SECRET_OUTPUT', is_error: true });
    process.exitCode = 1;
    return;
  }
  if (executor === 'claude') {
    emit({
      type: 'system',
      subtype: 'init',
      session_id: 'fake-reviewer',
      tools: ['Read'],
      ...(['two-pass', 'second-quota'].includes(mode) ? { model: 'review-model' } : {}),
    });
    emit({
      type: 'result',
      subtype: 'success',
      result: output,
      is_error: false,
      ...(['two-pass', 'second-quota'].includes(mode)
        ? {
            usage: {
              input_tokens: 1000,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          }
        : {}),
    });
  } else {
    require('./codex-rollout.cjs')('fake-reviewer-codex');
    emit({ type: 'thread.started', thread_id: 'fake-reviewer-codex' });
    emit({ type: 'turn.started' });
    emit({ type: 'item.completed', item: { id: 'output', type: 'agent_message', text: output } });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  }
});
