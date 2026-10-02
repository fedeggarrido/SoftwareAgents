#!/usr/bin/env node
// Synthetic protocol fixtures, not a claim of exhaustive CLI-version compatibility.
// Invoke with node fake-cli.cjs claude -p --output-format stream-json,
// or node fake-cli.cjs codex exec --json. Never touches HOME or authentication.
const [executor, ...args] = process.argv.slice(2);
const valid =
  executor === 'claude'
    ? args.includes('-p') && args.includes('--output-format') && args.includes('stream-json')
    : executor === 'codex' && args[0] === 'exec' && args.includes('--json');
if (!valid) {
  process.stderr.write('Expected claude -p --output-format stream-json or codex exec --json\n');
  process.exitCode = 2;
} else {
  if (args.includes('--inspect')) {
    const fs = require('fs');
    process.stdout.write(
      JSON.stringify({
        args,
        cwd: process.cwd(),
        settings: JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1])),
        mcp: JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1])),
      }) + '\n',
    );
    return;
  }
  if (args.includes('--child')) {
    const child = require('child_process').spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 3000)'],
      { stdio: 'ignore' },
    );
    process.stdout.write(String(child.pid) + '\n');
    setTimeout(() => {}, 3000);
    return;
  }
  const records =
    executor === 'claude'
      ? [
          {
            type: 'system',
            subtype: 'init',
            session_id: 'fake-claude-session',
            model: 'fake-model',
          },
          {
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'README.md' } },
              ],
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          },
          {
            type: 'rate_limit_event',
            rate_limit_info: {
              status: 'rejected',
              resetsAt: args.includes('--future-limit')
                ? Math.ceil(Date.now() / 1000) + 60
                : 1767225601,
              rateLimitType: 'five_hour',
            },
          },
          {
            type: 'result',
            subtype: 'success',
            result: 'Fake result',
            ...(args.includes('--typed-valid') ? { structured_output: { ok: true } } : {}),
            session_id: 'fake-claude-session',
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        ]
      : [
          { type: 'thread.started', thread_id: 'fake-codex-session' },
          { type: 'turn.started' },
          {
            type: 'item.completed',
            item: {
              id: 'tool-1',
              type: 'command_execution',
              command: 'echo fake',
              aggregated_output: 'fake',
              exit_code: 0,
              status: 'completed',
            },
          },
          {
            type: 'error',
            message: 'Synthetic rate limit',
            code: 'rate_limit_exceeded',
            retry_after_seconds: 1,
          },
          {
            type: 'item.completed',
            item: { id: 'output-1', type: 'agent_message', text: 'Fake result' },
          },
          {
            type: 'turn.completed',
            usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
          },
        ];
  for (const record of records) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}
