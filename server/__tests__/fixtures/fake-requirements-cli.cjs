// Protocol fixture only: no authentication, real CLIs or dependency installation.
const fs = require('fs');
const [executor, mode, log, ...args] = process.argv.slice(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});
process.stdin.on('end', () => {
  const context = JSON.parse(
    executor === 'codex' ? prompt.split('UNTRUSTED_CONTEXT_JSON\n')[1] : prompt,
  );
  const data = JSON.parse(context.task.brief);
  const attempts = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0;
  fs.appendFileSync(log, JSON.stringify({ args, data, cwd: process.cwd() }) + '\n');
  const spec = {
    apiVersion: 'softwareagents.io/v1alpha1',
    kind: 'FeatureSpec',
    key: 'FEAT-001',
    version: '1.0.0',
    status: 'draft',
    title: 'Audit view in Command Center',
    goal: 'Inspect audit events',
    userValue: 'Explain operator and runtime actions',
    actors: ['Operator'],
    flows: ['Open audit view'],
    rules: ['Read only'],
    edgeCases: ['Empty audit log'],
    acceptance: [
      {
        id: 'AC-001',
        given: 'Existing audit events',
        when: 'The operator opens the audit view',
        then: 'Events are visible',
        ears: 'When the operator opens the audit view, the system shall display audit events.',
      },
    ],
    openQuestions: mode === 'questions' ? ['Which retention period?', 'Which export formats?'] : [],
    links: { adr: [], clickup: [] },
  };
  if (mode === 'invalid' || (mode === 'repair' && attempts === 0)) delete spec.acceptance[0].then;
  if (mode === 'no-ears') delete spec.acceptance[0].ears;
  if (mode === 'wrong-key') spec.key = 'FEAT-002';
  if (mode === 'self-approved') spec.status = 'approved';
  if (mode === 'outside') fs.writeFileSync('outside.txt', 'unauthorized');
  if (mode === 'ignored') fs.writeFileSync('ignored.txt', 'unauthorized');
  if (mode === 'empty-dir') fs.mkdirSync('unauthorized-directory');
  if (mode === 'other-brain') fs.writeFileSync('.softwareagents/brain/RULES.md', 'unauthorized');
  const emit = (r) => console.log(JSON.stringify(r));
  if (executor === 'claude') {
    emit({
      type: 'system',
      subtype: 'init',
      session_id: 'fake-requirements-claude',
      tools: ['Read'],
    });
    emit({ type: 'result', subtype: 'success', result: JSON.stringify(spec), is_error: false });
  } else {
    require('./codex-rollout.cjs')('fake-requirements-codex');
    emit({ type: 'thread.started', thread_id: 'fake-requirements-codex' });
    emit({ type: 'turn.started' });
    emit({
      type: 'item.completed',
      item: { id: 'output', type: 'agent_message', text: JSON.stringify(spec) },
    });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  }
});
