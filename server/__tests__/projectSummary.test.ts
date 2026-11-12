import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HumanDecision } from '../../core/src/humanDecision.js';
import * as companyControl from '../src/companyControl.js';
import * as featurePlan from '../src/featurePlan.js';
import { projectFeatures } from '../src/featuresView.js';
import { loadProjectConfig } from '../src/projectConfig.js';
import {
  handleProjectSummaryMessage,
  projectSummary,
  type ProjectSummarySource,
  readProjectSummary,
} from '../src/projectSummary.js';
import { readSummaryContext } from '../src/projectSummaryContext.js';
import { otlpSpan, telemetryDirectory, type TelemetrySpan } from '../src/telemetry.js';
import * as telemetryCommand from '../src/telemetryCommand.js';
import { runMigrations } from '../src/workstore/migrations.js';

vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): ProjectSummarySource {
  return {
    name: 'Pedidos',
    work: {
      features: [],
      designs: [],
      tasks: [],
      runs: [],
      decisions: [],
      executions: [],
      events: [],
    },
    dependencies: [],
    context: { goals: [], risks: [], nextSteps: [], notices: [], ideas: [], approvals: [] },
    audit: {
      status: 'empty',
      entries: [],
      totalValid: 0,
      truncated: false,
      corruptLines: [],
      excludedCount: 0,
    },
  };
}

function task(feature: string, index: number, status: string, title = 'Crear recibos') {
  return {
    key: `${feature}-T0${index}`,
    feature_key: feature,
    version: 1,
    status,
    priority: 0,
    declaration: JSON.stringify({ title, description: 'PRIVATE_DESCRIPTION' }),
    updated_at: `2026-11-0${index}T10:00:00Z`,
  };
}

function ledger(costUsd: number | null, inputTokens: number | null = null) {
  return {
    body: JSON.stringify({
      featureKey: null,
      taskKey: 'unassigned-task',
      costUsd,
      inputTokens,
      outputTokens: inputTokens === null ? null : 7,
      cacheReadTokens: null,
      prompt: 'PRIVATE_PROMPT',
      model: 'PRIVATE_MODEL',
      quotaBefore: 'PRIVATE_QUOTA',
    }),
  };
}

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-summary-'));
  roots.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  vi.stubEnv('HOME', home);
  fs.mkdirSync(path.join(root, '.git/softwareagents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.softwareagents'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.softwareagents/project.yaml'),
    JSON.stringify({
      apiVersion: 'softwareagents.io/v1alpha1',
      kind: 'Project',
      id: 'summary-test',
      name: 'Pedidos',
      repo: { remote: 'local', defaultBranch: 'main' },
      brain: { path: '.softwareagents/brain' },
    }),
  );
  return root;
}

describe('project summary projection', () => {
  it('keeps a new project empty with explicit unknown cost and no generated facts', () => {
    const result = projectSummary(fixture());
    expect(result).toEqual({
      name: 'Pedidos',
      goals: [],
      features: [],
      workflow: expect.arrayContaining([
        expect.objectContaining({ id: 'idea', state: 'workflow_empty' }),
      ]),
      milestones: [],
      deliveries: [],
      decisions: [],
      risks: [],
      blockers: [],
      nextSteps: [],
      notices: [],
      cost: {
        source: 'none',
        executions: 0,
        costKnown: 0,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        tokenKnown: 0,
      },
    });
  });

  it('projects mixed FEATs, task progress, real milestones and latest finished work', () => {
    const data = fixture();
    data.work.features = [
      { key: 'FEAT-001', status: 'ready_to_merge', title: 'Pedidos' },
      { key: 'FEAT-002', status: 'approved', title: 'Recibos' },
      { key: 'FEAT-003', status: 'in_review', title: 'Historial' },
    ];
    data.work.designs = [{ feature_key: 'FEAT-002' }];
    data.work.tasks = [
      task('FEAT-001', 1, 'DONE'),
      task('FEAT-002', 1, 'DONE'),
      task('FEAT-002', 2, 'RUNNING'),
      task('FEAT-002', 3, 'READY'),
    ];
    data.work.runs = [
      {
        feature_key: 'FEAT-001',
        state: { branch: 'sa/FEAT-001-integration', head: 'a'.repeat(40) },
      },
    ];
    data.work.mainAncestors = new Set(['a'.repeat(40)]);
    data.context.goals = [{ key: 'FEAT-001', text: 'Gestionar pedidos de la tienda', at: null }];
    const result = projectSummary(data);
    expect(result.features.find((feature) => feature.key === 'FEAT-001')).toMatchObject({
      state: 'summary_done',
      done: 1,
      inProgress: 0,
      pending: 0,
    });
    expect(result.features.find((feature) => feature.key === 'FEAT-002')).toMatchObject({
      state: 'summary_in_progress',
      done: 1,
      inProgress: 1,
      pending: 1,
      total: 3,
    });
    expect(result.features.find((feature) => feature.key === 'FEAT-003')).toMatchObject({
      state: 'summary_pending',
      total: 0,
    });
    expect(result.milestones.map((item) => item.text)).toContain('Diseño preparado · Recibos');
    expect(result.deliveries.map((item) => item.text)).toContain(
      'Funcionalidad integrada · Pedidos',
    );
    expect(result.deliveries.some((item) => item.key === 'FEAT-002-T02')).toBe(false);
    expect(result.goals).toEqual(data.context.goals);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_DESCRIPTION');
  });

  it('requires Git ancestry before calling a feature done or integrated', () => {
    const data = fixture();
    data.work.features = [{ key: 'FEAT-001', status: 'ready_to_merge' }];
    data.work.tasks = [task('FEAT-001', 1, 'DONE')];
    const result = projectSummary(data);
    expect(result.features[0].state).toBe('summary_in_progress');
    expect(result.deliveries[0].text).toContain('Tarea terminada');
    expect(result.nextSteps[0].text).toContain('Integrar la funcionalidad');
  });

  it('keeps cancelled tasks separate from pending work', () => {
    const data = fixture();
    data.work.features = [{ key: 'FEAT-001', status: 'approved' }];
    data.work.tasks = [task('FEAT-001', 1, 'CANCELLED'), task('FEAT-001', 2, 'READY')];
    expect(projectSummary(data).features[0]).toMatchObject({ cancelled: 1, pending: 1, total: 2 });
    expect(projectSummary(data).nextSteps.map((item) => item.key)).toEqual(['FEAT-001-T02']);
  });

  it('includes open and expired decisions, omits answers, and filters ready work by dependencies and decisions', () => {
    const data = fixture();
    const decision: HumanDecision = {
      id: 'decision-1',
      context: '¿Permitir recibos sin correo?',
      options: [
        { id: 'review', label: 'Revisar', benefit: 'Aclarar', cost: 'Tiempo', risk: 'Retraso' },
      ],
      recommendation: 'PRIVATE_RECOMMENDATION',
      disagreement: [],
      impact: 'Registro',
      urgency: 'high',
      requestedBy: 'requirements',
      blocks: ['FEAT-001-T02'],
      status: 'open',
      answeredBy: null,
      answeredAt: null,
    };
    data.work.decisions = [
      { escalation: JSON.stringify(decision) },
      {
        escalation: JSON.stringify({
          ...decision,
          id: 'expired',
          status: 'expired',
          context: '¿Reintentar la entrega?',
        }),
      },
      {
        escalation: JSON.stringify({
          ...decision,
          id: 'answered',
          status: 'answered',
          answer: 'PRIVATE_ANSWER',
        }),
      },
    ];
    data.work.tasks = [
      task('FEAT-001', 1, 'DONE'),
      task('FEAT-001', 2, 'READY'),
      task('FEAT-001', 3, 'READY'),
      task('FEAT-001', 4, 'READY'),
      task('FEAT-001', 5, 'BLOCKED'),
    ];
    data.dependencies = [
      { task_key: 'FEAT-001-T03', depends_on_key: 'missing-task' },
      { task_key: 'FEAT-001-T04', depends_on_key: 'FEAT-001-T01' },
    ];
    const result = projectSummary(data);
    expect(result.decisions).toHaveLength(2);
    expect(result.nextSteps.map((item) => item.key)).toEqual([
      'decision-1',
      'expired',
      'FEAT-001-T04',
    ]);
    expect(result.blockers[0].text).toContain('Trabajo bloqueado');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_ANSWER|PRIVATE_RECOMMENDATION/);
    data.work.decisions = [
      {
        escalation: JSON.stringify({
          ...decision,
          context: `feature-requirements/FEAT-001/${'a'.repeat(64)}\n¿Es obligatorio el correo?`,
        }),
      },
      {
        escalation: JSON.stringify({
          ...decision,
          id: 'review',
          context: 'feature-review/FEAT-001-T02/PRIVATE_CAUSE',
        }),
      },
    ];
    const readable = projectSummary(data);
    expect(readable.decisions.map((item) => item.text)).toEqual([
      '¿Es obligatorio el correo?',
      'Revisar los cambios antes de continuar · Crear recibos',
    ]);
    expect(JSON.stringify(readable)).not.toMatch(/PRIVATE_CAUSE|feature-requirements|a{64}/);
  });

  it('uses confirmed audit timestamps for milestones without transmitting the audit payload', () => {
    const data = fixture();
    data.work.features = [{ key: 'FEAT-001', status: 'approved', title: 'Recibos' }];
    data.audit.entries = [
      {
        line: 1,
        occurredAt: '2026-11-01T10:00:00Z',
        actorType: 'human',
        actorId: 'operator',
        action: 'approve_featurespec',
        resourceType: 'feature',
        resourceId: 'FEAT-001',
        policyDecision: null,
        riskLevel: 'high',
        taskKey: null,
        executionId: null,
        outcome: {
          status: 'approved',
          reason: null,
          detail: 'PRIVATE_AUDIT_PAYLOAD',
          tier: null,
          executor: null,
          model: null,
          code: null,
        },
      },
    ];
    data.audit.corruptLines = [2];
    const result = projectSummary(data);
    expect(result.milestones[0]).toEqual({
      key: 'FEAT-001-spec',
      text: 'Requisitos aprobados · Recibos',
      at: '2026-11-01T10:00:00.000Z',
    });
    expect(result.notices).toContain('El historial de auditoría contiene entradas ilegibles.');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_AUDIT_PAYLOAD');
  });

  it('distinguishes absent, unknown, zero and partial real costs, including unassigned executions', () => {
    const data = fixture();
    data.work.ledger = [ledger(null)];
    expect(projectSummary(data).cost).toMatchObject({ executions: 1, costKnown: 0, costUsd: null });
    data.work.ledger = [ledger(0, 0)];
    expect(projectSummary(data).cost).toMatchObject({
      executions: 1,
      costKnown: 1,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 7,
    });
    data.work.ledger = [ledger(0.25, 100), ledger(null), ledger(0.5, 200)];
    const result = projectSummary(data);
    expect(result.cost).toEqual({
      source: 'ledger',
      executions: 3,
      costKnown: 2,
      costUsd: 0.75,
      inputTokens: 300,
      outputTokens: 14,
      tokenKnown: 2,
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|prompt|model|quotaBefore/);
  });

  it('redacts sensitive display text and fails closed on malformed data', () => {
    const data = fixture();
    data.name = 'Pedidos ghp_private123';
    data.work.tasks = [task('FEAT-001', 1, 'BLOCKED', 'Leer C:\\private\\input.txt')];
    expect(JSON.stringify(projectSummary(data))).not.toMatch(/ghp_private123|private/);
    data.work.ledger = [ledger(-1)];
    expect(() => projectSummary(data)).toThrow('invalid_data');
  });
});

describe('project summary canonical readers', () => {
  it('reuses the bound plan reader for goals, declared risks and pending approval', () => {
    const root = repository();
    const config = loadProjectConfig(root)!;
    const readPlan = vi.spyOn(featurePlan, 'readFeaturePlan').mockReturnValue({
      key: 'FEAT-001',
      title: 'Recibos',
      specSha: 'fixture',
      revision: 'revision',
      specApproved: true,
      approved: false,
      approvalState: 'unbound',
      sections: [],
      summary: {
        goal: 'Emitir recibos legibles',
        userValue: 'Conservar los pedidos',
        risks: ['Servicio de correo sin conexión'],
        outOfScope: [],
        acceptance: [],
        tasks: [],
      },
    });
    const work = fixture().work;
    work.features = [{ key: 'FEAT-001', title: 'Recibos', status: 'approved' }];
    const context = readSummaryContext(config, projectFeatures(work));
    expect(readPlan).toHaveBeenCalledWith(config, 'FEAT-001');
    expect(context.goals[0].text).toBe('Emitir recibos legibles');
    expect(context.risks[0].text).toBe('Servicio de correo sin conexión');
    expect(context.nextSteps[0].text).toBe('Revisar y aprobar el plan de Recibos');
    readPlan.mockImplementation(() => {
      throw new Error('PRIVATE_READ_ERROR');
    });
    const missing = readSummaryContext(config, projectFeatures(work));
    expect(missing.goals).toEqual([]);
    expect(missing.notices).toEqual([
      'Objetivo y riesgos de FEAT-001 no disponibles en su especificación vinculada.',
    ]);
  });
  it('reads a new manifest and saved idea without creating a WorkStore', async () => {
    const root = repository();
    expect(await readProjectSummary(root, 'summary-test')).toMatchObject({
      status: 'empty',
      summary: { name: 'Pedidos', features: [] },
    });
    const dir = path.join(root, '.softwareagents/ideas/summary-test');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'FEAT-001.md'),
      '# Idea\n\n    Una app de pedidos\n\n## Respuestas\n\n### Objetivo\n\n    Gestionar los pedidos de la tienda\n\n### Riesgos\n\n    Pérdida de conexión\n\n## Supuestos\n\nNinguno.\n',
    );
    const config = loadProjectConfig(root);
    expect(config).not.toBeNull();
    const context = readSummaryContext(config!, []);
    expect(context.goals[0].text).toBe('Gestionar los pedidos de la tienda');
    expect(context.risks[0].text).toBe('Pérdida de conexión');
    expect(await readProjectSummary(root, 'summary-test')).toMatchObject({
      status: 'ok',
      summary: { goals: context.goals },
    });
    expect(fs.existsSync(path.join(root, '.git/softwareagents/work.sqlite3'))).toBe(false);
  });

  it('scopes WorkStore and ledger reads to the selected Project without changing database bytes', async () => {
    const root = repository();
    const file = path.join(root, '.git/softwareagents/work.sqlite3');
    const db = new DatabaseSync(file);
    runMigrations(db);
    try {
      for (const [project, key, cost] of [
        ['summary-test', 'one', 0.75],
        ['other', 'two', 99],
      ] as const) {
        db.prepare('INSERT INTO projects(project_id,created_at) VALUES (?,?)').run(
          project,
          '2026-11-01',
        );
        db.prepare(
          `INSERT INTO tasks(project_id,key,type,status,priority,version,attempt,max_attempts,created_at,updated_at)
          VALUES (?,?,'code','DONE',0,1,0,1,'2026-11-01','2026-11-01')`,
        ).run(project, 'unassigned-task');
        db.prepare(
          `INSERT INTO executions(project_id,key,task_key,agent_template_version,executor,model_id,started_at,system_prompt_hash,project_brain_sha,task_version,tool_policy_version)
          VALUES (?,?,'unassigned-task','v1','codex','fixture','2026-11-01','private','private',1,'v1')`,
        ).run(project, key);
        db.prepare('INSERT INTO usage_ledger(project_id,execution_key,body) VALUES (?,?,?)').run(
          project,
          key,
          ledger(cost, 100).body,
        );
      }
    } finally {
      db.close();
    }
    const before = fs.readFileSync(file);
    const readTelemetry = vi.spyOn(telemetryCommand, 'telemetrySummary');
    expect(await readProjectSummary(root, 'summary-test')).toMatchObject({
      summary: { cost: { executions: 1, costUsd: 0.75, inputTokens: 100 } },
    });
    expect(fs.readFileSync(file)).toEqual(before);
    expect(readTelemetry).not.toHaveBeenCalled();
    expect(await readProjectSummary(root, 'other')).toEqual({
      status: 'unknown_project',
      reason: null,
      summary: null,
    });
  });

  it('reads retained telemetry when there is no ledger without inventing a cost or creating a database', async () => {
    const root = repository();
    const span: TelemetrySpan = {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      name: 'invoke_agent',
      kind: 1,
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      status: { code: 1 },
      attributes: [
        { key: 'softwareagents.task.key', value: { stringValue: 'task-one' } },
        { key: 'gen_ai.usage.input_tokens', value: { intValue: '120' } },
        { key: 'gen_ai.usage.output_tokens', value: { intValue: '7' } },
      ],
    };
    const dir = telemetryDirectory(path.join(root, '.git'), 'summary-test');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'spans.jsonl');
    fs.writeFileSync(file, `${JSON.stringify(otlpSpan(span))}\n`);
    const before = fs.readFileSync(file);
    expect(await readProjectSummary(root, 'summary-test')).toMatchObject({
      status: 'ok',
      summary: {
        cost: {
          source: 'retained_telemetry',
          executions: 1,
          costKnown: 0,
          costUsd: null,
          inputTokens: 120,
          outputTokens: 7,
          tokenKnown: null,
        },
      },
    });
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.existsSync(path.join(root, '.git/softwareagents/work.sqlite3'))).toBe(false);
  });

  it('reports an unreadable existing database distinctly from empty', async () => {
    const root = repository();
    fs.writeFileSync(path.join(root, '.git/softwareagents/work.sqlite3'), 'invalid database');
    expect(await readProjectSummary(root, 'summary-test')).toMatchObject({
      status: 'read_error',
      summary: null,
    });
  });
});

describe('summary ingress', () => {
  it('checks connection privilege before probing any repository or source', async () => {
    const root = vi.spyOn(companyControl, 'companyWorkspaceRoot').mockImplementation(() => {
      throw new Error('Must not probe');
    });
    const send = vi.fn();
    await handleProjectSummaryMessage(
      { type: 'requestProjectSummary', projectId: 'private', requestId: 'request' },
      send,
      false,
    );
    expect(root).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: 'projectSummarySnapshot',
      projectId: 'private',
      requestId: 'request',
      status: 'denied',
      reason: null,
      summary: null,
    });
  });

  it('rejects a different Project and extra client authority fields', async () => {
    const root = vi.spyOn(companyControl, 'companyWorkspaceRoot').mockReturnValue(repository());
    const send = vi.fn();
    await handleProjectSummaryMessage(
      { type: 'requestProjectSummary', projectId: 'other', requestId: 'request' },
      send,
      true,
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'unknown_project', summary: null }),
    );
    root.mockClear();
    send.mockClear();
    await handleProjectSummaryMessage(
      {
        type: 'requestProjectSummary',
        projectId: 'summary-test',
        requestId: 'request',
        actor: 'human',
      },
      send,
      true,
    );
    expect(root).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
