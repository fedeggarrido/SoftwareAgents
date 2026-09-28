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
    // A template placeholder is not a task.
    expect(
      roleFromBrief('Actúa como fundtrinsic-acceptance-reviewer --task FT-OPP-NNN', 'claude')
        .detail,
    ).toBeUndefined();
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

describe('RoleResolver', () => {
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
