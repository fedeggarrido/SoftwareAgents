import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claudeRoleFromTranscript,
  codexRole,
  codexRoleFromRollout,
  roleFromBrief,
  RoleResolver,
  specialistRole,
  taskFromCwd,
} from '../src/agentRoles.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import type { AgentState } from '../src/types.js';

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

function codexUser(text: string): string {
  return line({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });
}

describe('specialistRole', () => {
  it('drops any project prefix', () => {
    expect(specialistRole('fundtrinsic-code-reviewer')?.label).toBe('QA Código');
    expect(specialistRole('nemesis-code-reviewer')?.label).toBe('QA Código');
    expect(specialistRole('code-reviewer')?.label).toBe('QA Código');
  });

  it('knows the finance specialists', () => {
    expect(specialistRole('fundtrinsic-accounting-analyst')).toEqual({
      label: 'Analista Contable',
      department: 'Análisis',
      detail: undefined,
    });
    expect(specialistRole('fundtrinsic-financial-engine-engineer')?.department).toBe('Ingeniería');
  });

  it('is undefined for unknown names, never a guess', () => {
    expect(specialistRole('fundtrinsic-astronaut')).toBeUndefined();
    expect(specialistRole(undefined)).toBeUndefined();
  });
});

describe('roleFromBrief', () => {
  it('labels QA/Reviewer only when the brief or top-level metadata assigns that role', () => {
    expect(roleFromBrief('Rol: QA\nComprueba SA-026', 'codex')).toMatchObject({
      label: 'QA',
      department: 'Calidad',
    });
    expect(roleFromBrief('Actúa como Reviewer de SA-026', 'codex').label).toBe('Reviewer');
    expect(codexRole({ agent_role: 'reviewer' }, 'Revisa la tarea').label).toBe('Reviewer');
    expect(
      roleFromBrief('Implementa los fixes tras la QA; Claude hace de Reviewer', 'codex').label,
    ).toBe('Dueño');
    expect(roleFromBrief('¿Cómo funciona QA?', 'codex').label).toBe('Dueño');
  });
  it.each(['.', ',', ';', ':', ')', ']', '\u00bb', '"', "'"])(
    'trims closing punctuation %s from opaque task identifiers',
    (closing) => {
      expect(
        roleFromBrief('Act\u00faa como code-reviewer Tarea: opaque_task' + closing, 'codex').detail,
      ).toBe('tarea opaque_task');
      expect(roleFromBrief('Act\u00faa como code-reviewer --task (SA-012),', 'codex').detail).toBe(
        'tarea SA-012',
      );
    },
  );
  it('recognises the manager of any project', () => {
    expect(roleFromBrief('Usa $fundtrinsic-company-manager y revisa la cola', 'codex')).toEqual({
      label: 'Manager',
      department: 'Dirección',
    });
    expect(roleFromBrief('Usa $nemesis-company-manager', 'claude').detail).toBe('de relevo');
  });

  it('recognises the dispatched worker and its task', () => {
    const role = roleFromBrief('Implementa solo la tarea ClickUp 86c9abc12, sesión s1.', 'claude');
    expect(role).toEqual({
      label: 'DEV',
      department: 'Ingeniería',
      detail: 'tarea 86c9abc12',
    });
  });

  it('recognises a specialist launched by hand', () => {
    const role = roleFromBrief('Actúa como fundtrinsic-product-analyst. Lee y sigue...', 'codex');
    expect(role.label).toBe('Analista');
  });

  it("names the task a specialist's brief was given explicitly", () => {
    const role = roleFromBrief(
      'Actúa como fundtrinsic-product-analyst.\n... --session claude@x --task FT-OPP-001 --detail "..."',
      'claude',
    );
    expect(role).toEqual({
      label: 'Analista',
      department: 'Análisis',
      detail: 'tarea FT-OPP-001',
    });
    expect(
      roleFromBrief('Actúa como fundtrinsic-code-reviewer. Tarea: FT-OPP-022', 'claude').detail,
    ).toBe('tarea FT-OPP-022');
    // Task identifiers are opaque, including values without numeric suffixes.
    expect(
      roleFromBrief('Actúa como fundtrinsic-acceptance-reviewer --task FT-OPP-NNN', 'claude')
        .detail,
    ).toBe('tarea FT-OPP-NNN');
    expect(roleFromBrief('Actúa como code-reviewer --task opaque_task', 'codex').detail).toBe(
      'tarea opaque_task',
    );
  });

  it('falls back to a session with the owner', () => {
    expect(roleFromBrief('¿Por qué falla el build?', 'claude').label).toBe('Dueño');
  });
});

describe('codexRole', () => {
  it('uses the subagent metadata over the inherited brief', () => {
    const role = codexRole(
      {
        thread_source: 'subagent',
        agent_role: 'fundtrinsic-business-analyst',
        agent_nickname: 'Zeno',
      },
      'Actúa como fundtrinsic-product-analyst',
    );
    expect(role).toEqual({ label: 'Analista Negocio', department: 'Análisis', detail: 'Zeno' });
  });
});

describe('transcript and rollout readers', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips context the Codex CLI injects before the brief', () => {
    const file = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(
      file,
      line({ type: 'session_meta', payload: { thread_source: 'user', cwd: dir } }) +
        codexUser('<recommended_plugins>\n...') +
        codexUser('Actúa como fundtrinsic-product-analyst. Encargo...'),
    );
    expect(codexRoleFromRollout(file)?.label).toBe('Analista');
  });

  it('skips the AGENTS.md Codex injects before a worker brief', () => {
    const file = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(
      file,
      line({ type: 'session_meta', payload: { thread_source: 'user', cwd: dir } }) +
        codexUser(
          '# AGENTS.md instructions for D:\\repo\n\n<INSTRUCTIONS>...Actúa como manager de X',
        ) +
        codexUser(
          '# Instrucciones del trabajador\n...\nImplementa solo la tarea ClickUp 869f84a5f, sesión s.',
        ),
    );
    expect(codexRoleFromRollout(file)).toMatchObject({ label: 'DEV', detail: 'tarea 869f84a5f' });
  });

  it('waits (undefined) while a rollout has no brief yet', () => {
    const file = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(file, line({ type: 'session_meta', payload: { thread_source: 'user' } }));
    expect(codexRoleFromRollout(file)).toBeUndefined();
  });
  it.each(['QA', 'Reviewer'])(
    'reads an explicit main-session %s role before a brief arrives',
    (role) => {
      const file = path.join(dir, 'main-role.jsonl');
      fs.writeFileSync(
        file,
        line({
          type: 'session_meta',
          payload: { thread_source: 'user', cwd: 'D:/repo', agent_role: role },
        }),
      );
      expect(codexRoleFromRollout(file)).toMatchObject({ label: role, department: 'Calidad' });
    },
  );

  it('reads a Claude brief, ignoring meta and command records', () => {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(
      file,
      line({ type: 'user', isMeta: true, message: { content: 'Caveat: ...' } }) +
        line({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }) +
        line({
          type: 'user',
          message: { content: [{ type: 'text', text: 'Implementa solo la tarea ClickUp abc1' }] },
        }),
    );
    expect(claudeRoleFromTranscript(file)?.detail).toBe('tarea abc1');
  });
});

describe('worktree task labels', () => {
  it.each(['claude', 'codex'])('labels a registered %s Developer as DEV', (providerId) => {
    const store = new AgentStateStore();
    store.broadcast = () => {};
    store.set(1, { id: 1, sessionId: 'session', jsonlFile: '', providerId } as AgentState);
    new RoleResolver(
      store,
      2000,
      () => new Map([['session', { executionId: 'exec', role: 'developer', taskKey: 'SA-081' }]]),
    ).tick();
    expect(store.get(1)?.role).toEqual({
      label: 'DEV',
      department: 'Ingeniería',
      detail: 'tarea SA-081',
    });
  });
  it('uses registry metadata for a session without a transcript', () => {
    const store = new AgentStateStore();
    store.broadcast = () => {};
    store.set(1, { id: 1, sessionId: 'session', jsonlFile: '' } as AgentState);
    const resolver = new RoleResolver(
      store,
      2000,
      () => new Map([['session', { executionId: 'exec', role: 'integrator', taskKey: 'SA-078' }]]),
    );
    resolver.tick();
    expect(store.get(1)?.role).toEqual({
      label: 'integrator',
      department: 'Sesiones',
      detail: 'tarea SA-078',
    });
  });
  it.each([
    ['D:\\repo\\.worktrees\\SA-035b', 'SA-035'],
    ['/repo/.worktrees/SA-078-slug/server', 'SA-078'],
    ['/repo/.worktrees/SA-0350', undefined],
    ['/repo/SA-035b', undefined],
    ['/repo', undefined],
  ])('extracts a task only from a worktree cwd %s', (cwd, key) => {
    expect(taskFromCwd(cwd)).toBe(key);
  });

  it.each(['claude', 'codex'])(
    'labels %s and refreshes when registry metadata arrives',
    (provider) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-'));
      try {
        const file = path.join(dir, 'session.jsonl');
        const cwd = 'D:\\repo\\.worktrees\\SA-035b';
        fs.writeFileSync(
          file,
          provider === 'codex'
            ? line({ type: 'session_meta', payload: { cwd } })
            : line({ type: 'user', cwd, message: { content: 'Trabaja en esto' } }),
        );
        const store = new AgentStateStore();
        const sent: unknown[] = [];
        store.broadcast = (m) => void sent.push(m);
        store.set(1, {
          id: 1,
          sessionId: 'session',
          providerId: provider,
          jsonlFile: file,
        } as AgentState);
        const sessions = new Map<string, { executionId: string; role: string; taskKey: string }>();
        const resolver = new RoleResolver(store, 2000, () => sessions);
        resolver.tick();
        expect(store.get(1)?.role).toEqual({
          label: 'DEV',
          department: 'Ingeniería',
          detail: 'tarea SA-035',
        });
        resolver.tick();
        expect(sent).toHaveLength(1);
        sessions.set('session', { executionId: 'exec', role: 'code-reviewer', taskKey: 'SA-078' });
        resolver.tick();
        expect(store.get(1)?.role).toEqual({
          label: 'QA Código',
          department: 'Calidad',
          detail: 'tarea SA-078',
        });
        expect(sent).toHaveLength(2);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('RoleResolver', () => {
  it('labels a main-checkout Claude session without a readable brief as owner, then retries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-'));
    try {
      const file = path.join(dir, 'main.jsonl');
      fs.writeFileSync(
        file,
        line({ type: 'user', cwd: 'D:/repo', isMeta: true, message: { content: '<context>' } }),
      );
      const store = new AgentStateStore();
      store.broadcast = () => {};
      store.set(1, { id: 1, sessionId: 'main', jsonlFile: file } as AgentState);
      const resolver = new RoleResolver(store);
      resolver.tick();
      expect(store.get(1)?.role).toEqual({ label: 'Due\u00f1o', department: 'Sesiones' });
      fs.appendFileSync(
        file,
        line({
          type: 'user',
          cwd: 'D:/repo',
          message: { content: 'Act\u00faa como code-reviewer' },
        }),
      );
      resolver.tick();
      expect(store.get(1)?.role?.label).toBe('QA C\u00f3digo');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('assigns and broadcasts a role once, skipping sub-agent characters', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-'));
    try {
      const lead = path.join(dir, 'lead.jsonl');
      fs.writeFileSync(lead, codexUser('Usa $fundtrinsic-company-manager'));
      const store = new AgentStateStore();
      const sent: Record<string, unknown>[] = [];
      store.broadcast = (m) => void sent.push(m);
      store.set(1, { id: 1, providerId: 'codex', jsonlFile: lead } as unknown as AgentState);
      store.set(2, { id: 2, jsonlFile: lead, spawnToolUseId: 'tu1' } as unknown as AgentState);

      const resolver = new RoleResolver(store);
      resolver.tick();
      resolver.tick();

      expect(sent).toEqual([
        expect.objectContaining({
          type: 'agentRole',
          id: 1,
          label: 'Manager',
          department: 'Dirección',
        }),
      ]);
      expect(store.get(2)?.role).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
