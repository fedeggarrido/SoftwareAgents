import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { DomainEvent } from '../../core/src/domainEvents.js';
import type { DomainEventMessage, WorkSnapshot } from '../../core/src/messages.js';
import type { WorkStore } from '../src/workstore/WorkStore.js';

// Isolated HOME: the server writes discovery records under ~/.pixel-agents.
let tmpBase: string;
vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: () => tmpBase };
});
vi.mock('../src/workstore/processRecovery.js', () => ({
  processStartIdentity: vi.fn(async () => 'identity'),
  terminateExecutionTree: vi.fn(async () => {}),
}));

const { PixelAgentsServer } = await import('../src/server.js');
const { AgentStateStore } = await import('../src/agentStateStore.js');
const { openWorkStore } = await import('../src/workstore/SqliteWorkStore.js');
const { DomainEventRelay, createDomainEventRelay, eventsFromTransition } =
  await import('../src/domainEventRelay.js');

const decision = {
  id: 'decision',
  context: 'Choose a strategy',
  options: [{ id: 'review', label: 'Review', benefit: 'Confidence', cost: 'Time', risk: 'Delay' }],
  recommendation: 'Review',
  disagreement: [{ role: 'developer', position: 'Ship' }],
  impact: 'Blocks work',
  urgency: 'high' as const,
  requestedBy: 'developer',
  blocks: ['blocked'],
};

describe('eventsFromTransition', () => {
  const row = (from: string, to: string) =>
    ({
      id: 7,
      task_key: 'T',
      from_status: from,
      to_status: to,
      task_version: 3,
      attempt: 1,
      reason: 'r',
      created_at: '2026-10-12T10:00:00.000Z',
      agent_role: 'developer',
    }) as Parameters<typeof eventsFromTransition>[1];
  const kinds = (from: string, to: string, decisionId: string | null = null) =>
    eventsFromTransition('p', row(from, to), { executionId: null, decisionId }).map((e) => e.kind);

  it.each([
    ['DRAFT', 'READY', ['task.state_changed']],
    ['QUEUED', 'LEASED', ['task.state_changed', 'task.leased']],
    ['LEASED', 'RUNNING', ['task.state_changed', 'execution.started']],
    ['RUNNING', 'REVIEW', ['task.state_changed', 'execution.finished', 'review.requested']],
    ['REVIEW', 'QA', ['task.state_changed', 'qa.requested']],
    ['QA', 'RUNNING', ['task.state_changed', 'execution.started']],
    ['RUNNING', 'WAITING_QUOTA', ['task.state_changed', 'execution.finished', 'quota.waiting']],
    ['READY', 'WAITING_HUMAN', ['task.state_changed', 'human.decision.required']],
    ['LEASED', 'CANCELLED', ['task.state_changed']],
  ])('%s → %s yields %j', (from, to, expected) => {
    expect(kinds(from, to)).toEqual(expected);
  });

  it('answers a decision only when the log names it', () => {
    expect(kinds('WAITING_HUMAN', 'READY')).toEqual(['task.state_changed']);
    expect(kinds('WAITING_HUMAN', 'READY', 'd1')).toEqual([
      'task.state_changed',
      'human.decision.answered',
    ]);
  });

  it('carries the common fields on every kind', () => {
    for (const event of eventsFromTransition('p', row('RUNNING', 'REVIEW'), {
      executionId: 'run',
      decisionId: null,
    }))
      expect(event).toMatchObject({
        eventId: 7,
        projectId: 'p',
        taskKey: 'T',
        agentRole: 'developer',
        executionId: 'run',
        at: Date.parse('2026-10-12T10:00:00.000Z'),
        fromStatus: 'RUNNING',
        toStatus: 'REVIEW',
      });
  });
});

describe('DomainEventRelay (real WorkStore)', () => {
  let root: string;
  let dbFile: string;
  let work: WorkStore | undefined;
  const relays: InstanceType<typeof DomainEventRelay>[] = [];

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-domain-events-'));
    fs.mkdirSync(path.join(tmpBase, '.pixel-agents'), { recursive: true });
    root = path.join(tmpBase, 'repo');
    fs.mkdirSync(root);
    execFileSync('git', ['init', root], { stdio: 'pipe', windowsHide: true });
    dbFile = path.join(root, '.git/softwareagents/work.sqlite3');
  });
  afterEach(() => {
    for (const relay of relays.splice(0)) relay.dispose();
    work?.close();
    work = undefined;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  async function openStore(): Promise<WorkStore> {
    work = await openWorkStore({ repositoryPath: root, projectId: 'test' });
    return work;
  }
  function relay(store: InstanceType<typeof AgentStateStore>, pollMs = 3_600_000) {
    const created = new DomainEventRelay(store, {
      projectId: 'test',
      workStoreFile: () => dbFile,
      pollMs,
    });
    relays.push(created);
    return created;
  }
  function captured(store: InstanceType<typeof AgentStateStore>): DomainEvent[] {
    const events: DomainEvent[] = [];
    store.on('broadcast', (msg: Record<string, unknown>) => {
      if (msg.type === 'domainEvent')
        events.push((msg as unknown as DomainEventMessage).event as DomainEvent);
    });
    return events;
  }

  it('relays a transition to a WebSocket client as a domainEvent', async () => {
    const tasks = await openStore();
    tasks.createTask({ key: 'T1', type: 'implementation', agent_role: 'developer' });
    const store = new AgentStateStore();
    relay(store, 25).start();
    const server = new PixelAgentsServer();
    try {
      const { port } = await server.start({ embedded: false, store });
      const socket = new WebSocket(`ws://127.0.0.1:${port.toString()}/ws`);
      const received: DomainEventMessage[] = [];
      let snapshot: WorkSnapshot | undefined;
      socket.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type === 'domainEvent') received.push(msg as DomainEventMessage);
        if (msg.type === 'workSnapshot') snapshot = msg as WorkSnapshot;
      });
      await new Promise((resolve) => socket.on('open', resolve));
      socket.send(JSON.stringify({ type: 'webviewReady' }));
      await vi.waitFor(() => expect(snapshot).toBeDefined(), { timeout: 5_000 });
      expect(snapshot!.tasks.map((t) => [t.key, t.status])).toEqual([['T1', 'DRAFT']]);

      await tasks.transition('T1', 1, 'READY', 'triaged', 'manager');
      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5_000 });
      expect(received[0].event).toEqual({
        eventId: expect.any(Number),
        kind: 'task.state_changed',
        projectId: 'test',
        taskKey: 'T1',
        agentRole: 'developer',
        executionId: null,
        at: expect.any(Number),
        fromStatus: 'DRAFT',
        toStatus: 'READY',
        taskVersion: 2,
        attempt: 0,
      });
      // Free-text reasons and actors never leave the server.
      expect(JSON.stringify(received[0])).not.toMatch(/triaged|manager/);
      expect(received[0].event.eventId).toBeGreaterThan(snapshot!.lastEventId ?? 0);
      socket.terminate();
    } finally {
      server.stop();
    }
  });

  it('gives a late client the current state through workSnapshot, not replayed history', async () => {
    const tasks = await openStore();
    tasks.createTask({ key: 'A', type: 'implementation', status: 'READY', priority: 1 });
    tasks.createTask({ key: 'B', type: 'implementation', agent_role: 'qa' });
    tasks.createTask({ key: 'blocked', type: 'implementation', status: 'READY' });
    tasks.addTaskDependency('B', 'A');
    await tasks.transition('A', 1, 'QUEUED', 'go', 'manager');
    await tasks.openDecision(decision);

    const store = new AgentStateStore();
    const events = captured(store);
    const started = relay(store);
    started.start();
    started.tick();
    expect(events).toEqual([]); // history is state, not news

    const server = new PixelAgentsServer();
    try {
      const { port } = await server.start({ embedded: false, store });
      const socket = new WebSocket(`ws://127.0.0.1:${port.toString()}/ws`);
      let snapshot: WorkSnapshot | undefined;
      socket.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type === 'workSnapshot') snapshot = msg as WorkSnapshot;
      });
      await new Promise((resolve) => socket.on('open', resolve));
      socket.send(JSON.stringify({ type: 'webviewReady' }));
      await vi.waitFor(() => expect(snapshot).toBeDefined(), { timeout: 5_000 });
      expect(snapshot).toMatchObject({
        type: 'workSnapshot',
        projectId: 'test',
        source: 'ok',
        lastEventId: Math.max(...tasks.listDomainEvents().map((e) => e.id)),
      });
      expect(snapshot!.tasks.map((t) => [t.key, t.status, t.dependsOn, t.agentRole])).toEqual([
        ['A', 'QUEUED', [], null],
        ['B', 'DRAFT', ['A'], 'qa'],
        ['blocked', 'WAITING_HUMAN', [], null],
      ]);
      expect(snapshot!.decisions).toEqual([
        {
          id: 'decision',
          status: 'open',
          context: 'Choose a strategy',
          options: decision.options,
          recommendation: 'Review',
          urgency: 'high',
          impact: 'Blocks work',
          requestedBy: 'developer',
          blocks: ['blocked'],
        },
      ]);
      socket.terminate();
    } finally {
      server.stop();
    }
  });

  it('names the decision behind required/answered and closes it in the next snapshot', async () => {
    const tasks = await openStore();
    tasks.createTask({ key: 'blocked', type: 'implementation', status: 'READY' });
    const store = new AgentStateStore();
    const events = captured(store);
    const started = relay(store);
    started.start();
    await tasks.openDecision(decision);
    started.tick();
    await tasks.resolveDecision('decision', 'review', 'fede', () => {});
    started.tick();
    expect(events.filter((e) => e.kind.startsWith('human.'))).toEqual([
      expect.objectContaining({ kind: 'human.decision.required', decisionId: 'decision' }),
      expect.objectContaining({ kind: 'human.decision.answered', decisionId: 'decision' }),
    ]);
    expect(started.snapshot().decisions).toEqual([]);
  });

  it('attributes an Execution only within its own lease window', async () => {
    const tasks = await openStore();
    tasks.createTask({ key: 'T', type: 'implementation', status: 'QUEUED', max_attempts: 3 });
    const store = new AgentStateStore();
    const events = captured(store);
    const started = relay(store);
    started.start();
    const leased = await tasks.claim('T', 'worker-1');
    await tasks.createExecution({
      key: 'run-1',
      task_key: 'T',
      agent_template_version: 'developer@v1',
      executor: 'codex',
      model_id: 'model',
      session_id: null,
      pid: null,
      started_at: new Date().toISOString(),
      system_prompt_hash: 'hash',
      project_brain_sha: 'sha',
      task_version: leased.version,
      tool_policy_version: 'v1',
    });
    const running = await tasks.transition('T', leased.version, 'RUNNING', 'start', 'worker-1');
    const failed = await tasks.transition('T', running.version, 'FAILED_RETRYABLE', 'x', 'w');
    const ready = await tasks.transition('T', failed.version, 'READY', 'retry', 'manager');
    await tasks.transition('T', ready.version, 'QUEUED', 'go', 'manager');
    await tasks.claim('T', 'worker-2'); // second attempt: no Execution recorded yet
    started.tick();
    const byKind = (kind: string) =>
      events.filter((e) => e.kind === kind).map((e) => e.executionId);
    expect(byKind('execution.started')).toEqual(['run-1']);
    expect(byKind('execution.finished')).toEqual(['run-1']);
    expect(byKind('task.leased')).toEqual(['run-1', null]);
    expect(
      events.filter((e) => e.kind === 'task.state_changed' && e.toStatus === 'READY')[0]
        .executionId,
    ).toBeNull();
  });

  it('reports a missing WorkStore and relays everything a later one records', async () => {
    const store = new AgentStateStore();
    const events = captured(store);
    const started = relay(store);
    started.start();
    expect(started.snapshot()).toMatchObject({ source: 'missing', tasks: [], lastEventId: null });
    const tasks = await openStore();
    tasks.createTask({ key: 'T', type: 'implementation' });
    await tasks.transition('T', 1, 'READY', 'r', 'a');
    started.tick();
    expect(events.map((e) => [e.kind, e.taskKey])).toEqual([['task.state_changed', 'T']]);
  });

  it('neither replays history nor reports empty work while the WorkStore cannot be located', async () => {
    const tasks = await openStore();
    tasks.createTask({ key: 'T', type: 'implementation' });
    await tasks.transition('T', 1, 'READY', 'r', 'a');
    const store = new AgentStateStore();
    const events = captured(store);
    let located = false;
    const flaky = new DomainEventRelay(store, {
      projectId: 'test',
      workStoreFile: () => (located ? dbFile : undefined),
      pollMs: 3_600_000,
    });
    relays.push(flaky);
    flaky.start();
    expect(flaky.snapshot().source).toBe('unreadable');
    located = true;
    flaky.tick();
    expect(events).toEqual([]);
    await tasks.transition('T', 2, 'QUEUED', 'r', 'a');
    flaky.tick();
    expect(events.map((e) => ('toStatus' in e ? e.toStatus : null))).toEqual(['QUEUED']);
  });

  it('only relays for a valid Project binding', () => {
    const store = new AgentStateStore();
    expect(createDomainEventRelay(store, root, { kind: 'legacy' })).toBeUndefined();
    expect(createDomainEventRelay(store, root, { kind: 'invalid', notice: 'x' })).toBeUndefined();
  });
});
