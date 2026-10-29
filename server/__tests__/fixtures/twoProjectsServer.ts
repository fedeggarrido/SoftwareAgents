// Bundled into a child process: globals and the operator profile belong to one Project.
import * as path from 'path';

import { AgentRuntime } from '../../src/agentRuntime.js';
import { AgentStateStore } from '../../src/agentStateStore.js';
import { AuditLog } from '../../src/auditLog.js';
import { loadBoardSelection } from '../../src/boardSources.js';
import { BoardWatcher } from '../../src/boardWatcher.js';
import { CodexWatcher } from '../../src/codexWatcher.js';
import { configureCompanyControl } from '../../src/companyControl.js';
import { createDomainEventRelay } from '../../src/domainEventRelay.js';
import { FileStateAdapter } from '../../src/fileStateAdapter.js';
import { claudeProvider } from '../../src/providers/index.js';
import { PixelAgentsServer } from '../../src/server.js';
import { openWorkStore } from '../../src/workstore/SqliteWorkStore.js';

async function main(): Promise<void> {
  const root = process.cwd();
  const id = process.env.TEST_PROJECT!;
  const selection = loadBoardSelection(root);
  configureCompanyControl(root, selection);
  const work = await openWorkStore({ repositoryPath: root, projectId: id });
  work.createFeature({
    key: id === 'project-a' ? 'FEAT-001' : 'FEAT-002',
    title: `title-${id}`,
    doc_path: 'feature.md',
    git_sha: 'a'.repeat(40),
    status: 'draft',
  });
  work.createTask({ key: `task-${id}`, type: 'code', status: 'READY' });
  await work.openDecision({
    id: `decision-${id}`,
    context: `context-${id}`,
    options: [
      { id: 'review', label: 'Review', benefit: 'Confidence', cost: 'Time', risk: 'Delay' },
    ],
    recommendation: 'Review',
    disagreement: [],
    impact: 'Blocks work',
    urgency: 'high',
    requestedBy: 'human',
    blocks: [`task-${id}`],
  });
  // Both projects' audit files coexist in each operator profile, testing the read filter.
  for (const projectId of ['project-a', 'project-b'])
    new AuditLog().append({
      projectId,
      actorType: 'human',
      actorId: 'operator',
      action: `action-${projectId}`,
      resourceType: 'task',
      resourceId: `task-${projectId}`,
      policyDecision: null,
      riskLevel: 'low',
      outcome: { status: 'ok' },
      taskKey: `task-${projectId}`,
      executionId: null,
    });
  const store = new AgentStateStore();
  store.bindProjectWorkspace(root);
  store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
  const runtime = new AgentRuntime(store, claudeProvider);
  runtime.watchAllSessions.current = true;
  const board = new BoardWatcher(store, root, Date.now, selection);
  board.start();
  const relay = createDomainEventRelay(store, root, selection);
  relay?.start();
  const codex = new CodexWatcher({
    store,
    workspaceDir: root,
    removeAgent: (agent) => runtime.removeAgent(agent),
  });
  const server = new PixelAgentsServer();
  server.onHookEvent((provider, event) => runtime.handleHookEvent(provider, event));
  const config = await server.start({ embedded: false, store, runtime });
  process.on('message', (message) => {
    if (message === 'scan') {
      const dir = claudeProvider.getSessionDirs!(root)[0];
      runtime.startProjectScan(dir);
      runtime.startExternalScanning(dir);
      codex.start();
      process.send?.('scanning');
    }
    if (message === 'stop') {
      codex.dispose();
      runtime.dispose();
      board.dispose();
      relay?.dispose();
      work.close();
      server.stop();
      process.disconnect?.();
    }
  });
  process.send?.({ port: config.port, token: config.token, root: path.resolve(root) });
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
