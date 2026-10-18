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
  const proposal = {
    components: ['Audit reader', 'Command Center'],
    risks: ['Large audit files'],
    body: '# Technical design\nRead audit pages without modifying the log.',
    dag: {
      apiVersion: 'softwareagents.io/v1alpha1',
      kind: 'TaskDAG',
      feature: 'FEAT-001',
      tasks: [
        {
          key: 'FEAT-001-T01',
          type: 'code',
          title: 'Read audit',
          description: 'Read paginated events',
          acceptanceRefs: ['AC-001'],
          dependsOn: [],
          agentRole: 'developer',
          size: 'M',
          changeZones: ['server/src/audit*.ts'],
          parallelizable: true,
        },
        {
          key: 'FEAT-001-T02',
          type: 'qa',
          title: 'Verify audit',
          description: 'Verify view',
          acceptanceRefs: ['AC-001'],
          dependsOn: ['FEAT-001-T01'],
          agentRole: 'qa',
          size: 'S',
          changeZones: ['server/__tests__/*.test.ts'],
          parallelizable: false,
        },
      ],
    },
    adrs: [{ title: 'Read only audit', body: 'Use existing audit reader.' }],
  };
  if (mode === 'developer-dependency') {
    proposal.dag.tasks[0].dependsOn = ['FEAT-001-T02'];
    Object.assign(proposal.dag.tasks[1], {
      type: 'code',
      agentRole: 'developer',
      dependsOn: [],
      changeZones: ['server/src/audit*.ts'],
    });
  }
  if (mode === 'invalid' || (mode === 'repair' && !data.validationErrors.length))
    proposal.dag.tasks[0].acceptanceRefs = [];
  if (mode === 'invalid' || (mode === 'repair' && !data.validationErrors.length))
    proposal.dag.tasks[1].acceptanceRefs = [];
  if (mode === 'protected-repair' && !data.validationErrors.length)
    proposal.dag.tasks[0].changeZones = ['.git/config'];
  if (mode === 'outside') fs.writeFileSync('outside.txt', 'unauthorized');
  const output = JSON.stringify(proposal);
  const emit = (r) => console.log(JSON.stringify(r));
  if (executor === 'claude') {
    emit({
      type: 'system',
      subtype: 'init',
      session_id: 'fake-requirements-claude',
      tools: ['Read'],
    });
    emit({ type: 'result', subtype: 'success', result: output, is_error: false });
  } else {
    require('./codex-rollout.cjs')('fake-requirements-codex');
    emit({ type: 'thread.started', thread_id: 'fake-requirements-codex' });
    emit({ type: 'turn.started' });
    emit({
      type: 'item.completed',
      item: { id: 'output', type: 'agent_message', text: output },
    });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  }
});
