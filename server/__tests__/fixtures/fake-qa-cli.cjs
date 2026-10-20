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
    verdict: ['fail', 'not_tested'].includes(mode) ? mode : 'pass',
    acceptance: data.task.acceptanceRefs.map((ac) => ({
      ac,
      status: ['fail', 'not_tested'].includes(mode) ? mode : 'pass',
      evidence: 'Runtime assertions and source inspected',
    })),
    commands: data.commands,
    defects:
      mode === 'fail'
        ? [
            {
              ac: data.task.acceptanceRefs[0],
              severity: 'major',
              summary: 'Missing edge case',
              reproduction: 'Open audit with no entries',
            },
          ]
        : [],
  };
  if (mode === 'invent-command')
    report.commands = [{ command: 'npm install', result: 'pass', passed: 1, failed: 0 }];
  if (mode === 'invalid' || (mode === 'repair' && !data.validationErrors.length))
    report.verdict = 'invalid';
  if (mode === 'outside') fs.writeFileSync('outside.txt', 'unauthorized');
  if (mode === 'changed-sha')
    require('child_process').execFileSync(
      'git',
      ['-c', 'core.hooksPath=', 'commit', '--allow-empty', '-m', 'moved'],
      { windowsHide: true },
    );
  const value =
    mode === 'request-command' && data.commandAllowlist.length
      ? { requestCommands: [data.commandAllowlist[0]] }
      : report;
  const output = '```json\n' + JSON.stringify(value) + '\n```';
  const emit = (value) => console.log(JSON.stringify(value));
  if (mode.startsWith('fail-')) {
    const reason = {
      'fail-oauth': 'another Claude Code process is refreshing it',
      'fail-auth': 'not logged in',
      'fail-spawn': 'spawn ENOENT',
      'fail-timeout': 'timeout',
      'fail-quota': 'usage limit reached',
    }[mode];
    if (mode === 'fail-quota')
      emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } });
    emit({ type: 'result', subtype: 'error', result: reason + ' SECRET_OUTPUT', is_error: true });
    process.exitCode = 1;
    return;
  }
  if (executor === 'claude') {
    emit({ type: 'system', subtype: 'init', session_id: 'fake-qa', tools: ['Read'] });
    emit({ type: 'result', subtype: 'success', result: output, is_error: false });
  } else {
    require('./codex-rollout.cjs')('fake-qa-codex');
    emit({ type: 'thread.started', thread_id: 'fake-qa-codex' });
    emit({ type: 'turn.started' });
    emit({ type: 'item.completed', item: { id: 'output', type: 'agent_message', text: output } });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  }
});
