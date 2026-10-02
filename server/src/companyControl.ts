import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { recordAudit } from './auditLog.js';
import { type BoardSelection, BoardSources, loadBoardSelection } from './boardSources.js';
import { companyAutopilotKey, readConfig } from './configPersistence.js';
import { resolveInside } from './pathGuard.js';
import type { PolicyDecision } from './policy.js';
import { loadProjectConfig } from './projectConfig.js';

/**
 * The two things the office may change in the agent company, both declared by the
 * workspace's own docs/backlog/board.json and only for privileged (tokened) clients:
 *  - autopilot on/off: flips `enabled` in the supervisor's state file and, when
 *    turning it on with no live supervisor, starts the operator-authorized command
 *    detached in the workspace. The supervisor itself decides everything else.
 *  - answering an owner decision in `decisionsFile`: only one of its listed options.
 * Nothing else is executable from the office.
 */

interface BoardConfig {
  decisionsFile?: string;
  autopilot?: { stateFile?: string; command?: string[] };
}

let workspace: string | undefined;
let sources: BoardSources | undefined;

/** Server-bound workspace; never take a policy target from a client message. */
export function companyWorkspaceRoot(): string | undefined {
  return workspace;
}

export function configureCompanyControl(dir: string, selection?: BoardSelection): void {
  const resolved = path.resolve(dir);
  const binding = new BoardSources(resolved, selection ?? loadBoardSelection(resolved));
  workspace = resolved;
  sources = binding;
}

function boardConfig(): BoardConfig | undefined {
  if (!workspace) return undefined;
  try {
    const file = sources?.boardFile();
    if (!file) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as BoardConfig;
  } catch {
    return undefined;
  }
}

function commonDir(): string | undefined {
  if (!workspace) return undefined;
  try {
    return execFileSync(
      'git',
      ['-C', workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

function alive(pid: unknown): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function statePath(cfg: BoardConfig | undefined): string | undefined {
  if (sources?.selection.kind === 'invalid') return undefined;
  if (!workspace) return undefined;
  const file =
    readConfig().companyAutopilot[companyAutopilotKey(workspace)]?.stateFile ??
    cfg?.autopilot?.stateFile;
  if (file === undefined) return undefined;
  resolveInside(workspace, file);
  const dir = commonDir();
  return dir ? resolveInside(dir, file) : undefined;
}

export function autopilotStatePath(): string | undefined {
  try {
    return statePath(boardConfig());
  } catch {
    return undefined;
  }
}

export function readAutopilot(): Record<string, unknown> | undefined {
  const file = autopilotStatePath();
  if (!file) return undefined;
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    return { ...state, running: alive(state.pid) };
  } catch {
    return { enabled: false, status: 'paused', running: false };
  }
}

function performAutopilot(enabled: boolean, result: { status: string }): string {
  if (sources?.selection.kind === 'invalid') return sources.selection.notice;
  const cfg = boardConfig();
  if (!workspace) return 'Este workspace no declara piloto automático.';
  const authorized = readConfig().companyAutopilot[companyAutopilotKey(workspace)];
  if (enabled && !authorized)
    return 'Piloto automático no autorizado: configura companyAutopilot en ~/.pixel-agents/config.json.';
  const declared = cfg?.autopilot?.command;
  if (
    enabled &&
    authorized &&
    declared !== undefined &&
    (!Array.isArray(declared) ||
      declared.length !== authorized.command.length ||
      !declared.every((arg, index) => arg === authorized.command[index]))
  ) {
    return 'Piloto automático no autorizado: el comando del board no coincide exactamente con el del operador.';
  }
  let file: string | undefined;
  try {
    file = statePath(cfg);
  } catch {
    return 'Ruta stateFile rechazada: debe ser relativa y no contener ..';
  }
  if (!file) return 'Este workspace no declara piloto automático.';
  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    /* first use */
  }
  writeJsonAtomic(file, { intervalMinutes: 20, ...state, enabled, updatedAt: Date.now() / 1000 });
  result.status = 'success';
  const command = authorized?.command;
  if (enabled && !alive(state.pid) && Array.isArray(command) && command.length > 0) {
    const child = spawn(command[0], command.slice(1), {
      cwd: workspace,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return `Piloto automático en marcha (pid ${child.pid ?? '?'}).`;
  }
  return enabled
    ? 'Piloto automático activado.'
    : 'Piloto automático en pausa tras la ronda actual.';
}

function performDecision(id: string, answer: string, result: { status: string }): string {
  if (sources?.selection.kind === 'invalid') return sources.selection.notice;
  const cfg = boardConfig();
  if (!workspace || !cfg?.decisionsFile) return 'Este workspace no declara bandeja de decisiones.';
  let file: string;
  try {
    file = resolveInside(workspace, cfg.decisionsFile);
  } catch {
    return 'Ruta decisionsFile rechazada: debe ser relativa y no contener ..';
  }
  let data: { decisions?: Array<Record<string, unknown>> };
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf-8')) as typeof data;
  } catch {
    return 'No se pudo leer la bandeja de decisiones.';
  }
  const decision = data.decisions?.find((d) => d.id === id);
  if (!decision) return `No existe la decisión ${id}.`;
  const options = Array.isArray(decision.options) ? (decision.options as string[]) : [];
  if (!options.includes(answer)) return 'La respuesta debe ser una de las opciones listadas.';
  decision.answer = answer;
  decision.status = 'answered';
  decision.answeredAt = new Date().toISOString();
  writeJsonAtomic(file, data);
  result.status = 'success';
  return `${id}: «${answer}» guardada. El manager la aplicará en su próxima ronda.`;
}

/** Policy comes from authenticated ingress, never from a client payload. */
export function setAutopilot(
  enabled: boolean,
  policyDecision: PolicyDecision | null = null,
): string {
  return auditCompany(
    'companyAutopilot',
    'autopilot',
    null,
    { enabled },
    policyDecision,
    (result) => performAutopilot(enabled, result),
  );
}

export function answerDecision(
  id: string,
  answer: string,
  policyDecision: PolicyDecision | null = null,
): string {
  return auditCompany('companyDecision', 'decision', id, { answer }, policyDecision, (result) =>
    performDecision(id, answer, result),
  );
}

function auditCompany(
  action: string,
  resourceType: string,
  resourceId: string | null,
  input: unknown,
  policyDecision: PolicyDecision | null,
  perform: (result: { status: string }) => string,
): string {
  const result = { status: 'rejected' };
  try {
    return perform(result);
  } catch (error) {
    result.status = 'failure';
    throw error;
  } finally {
    let projectId: string | null = null;
    try {
      projectId = workspace ? (loadProjectConfig(workspace)?.project.id ?? null) : null;
    } catch {
      /* Invalid manifest: machine audit. */
    }
    recordAudit(
      action,
      resourceType,
      resourceId,
      // Notices can repeat free-form decision answers. Keep them out of the
      // audit record; only their redacted input hash and result are needed.
      { status: result.status },
      { projectId, policyDecision, input },
    );
  }
}
