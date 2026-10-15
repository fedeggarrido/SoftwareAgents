// Deterministic cascade harness. Never launches a model or reads authentication.
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'verify') {
  console.log('VERIFIER_OUTPUT_MUST_NOT_BE_STORED');
  if (
    process.env.CASCADE_SECRET ||
    process.env.CI ||
    process.env.NODE_OPTIONS ||
    !process.env.HOME ||
    process.env.HOME !== process.env.USERPROFILE ||
    require('os').homedir() !== process.env.HOME
  )
    process.exit(9);
  if (
    args.includes('timeout') &&
    !fs.readFileSync('worker-result.md', 'utf8').startsWith('solved')
  ) {
    const child = require('child_process').spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'inherit' },
    );
    fs.writeFileSync(args[2], JSON.stringify({ parent: process.pid, child: child.pid }));
    setInterval(() => {}, 1000);
  } else {
    process.exitCode = fs.readFileSync('worker-result.md', 'utf8').startsWith('solved') ? 0 : 1;
  }
} else {
  if (fs.existsSync('failed.tmp') || fs.existsSync('ignored.tmp'))
    throw new Error('Previous attempt leaked');
  const model = args[args.indexOf('--model') + 1] ?? args[args.indexOf('-m') + 1];
  const solved = model === `test-${args.find((a) => a.startsWith('--solve-at='))?.split('=')[1]}`;
  fs.writeFileSync('worker-result.md', `${solved ? 'solved' : 'failed'} ${model}`);
  if (!solved) {
    fs.writeFileSync('failed.tmp', 'discard me');
    fs.writeFileSync('ignored.tmp', 'discard ignored files too');
  }
  if (!args.includes('-p') || !args.includes('stream-json'))
    throw new Error('Expected Claude protocol');
  if (args.includes('--write-protected')) {
    fs.mkdirSync('.github/workflows', { recursive: true });
    fs.writeFileSync('.github/workflows/ci.yml', 'synthetic: true');
  }
  const emit = (record) => console.log(JSON.stringify(record));
  emit({ type: 'system', subtype: 'init', session_id: `cascade-${model}`, model: 'claude-test' });
  emit({
    type: 'result',
    subtype: 'success',
    session_id: `cascade-${model}`,
    result: 'fake',
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 3,
    },
  });
  if (args.includes('--fail')) process.exitCode = 1;
}
