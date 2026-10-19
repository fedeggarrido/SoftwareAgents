import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AuditEntry, AuditLog } from '../src/auditLog.js';
import { readAuditView } from '../src/auditView.js';

vi.mock('os', async (original) => ({
  ...(await original<typeof import('os')>()),
  homedir: () => process.env.HOME!,
}));

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 'id',
    occurredAt: '2026-10-16T10:00:05Z',
    projectId: 'sample',
    actorType: 'human',
    actorId: null,
    action: 'read',
    resourceType: 'task',
    resourceId: null,
    policyDecision: null,
    riskLevel: 'low',
    inputHash: 'never-display',
    outcome: { status: 'success' },
    taskKey: null,
    executionId: null,
    ...overrides,
  };
}

describe('readAuditView acceptance', () => {
  let home: string;
  let file: string;
  const write = (lines: unknown[]) =>
    fs.writeFileSync(
      file,
      lines.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n'),
    );
  beforeEach(() => {
    home = fs.mkdtempSync(path.resolve('audit-view-test-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('TEMP', home);
    vi.stubEnv('TMP', home);
    file = new AuditLog().file('sample');
    fs.mkdirSync(path.dirname(file), { recursive: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('AC-007/008: distinguishes missing, blank and unreadable logs', async () => {
    expect((await readAuditView('sample')).status).toBe('empty');
    for (const text of ['', '  \r\n\t\n']) {
      fs.writeFileSync(file, text);
      expect((await readAuditView('sample')).status).toBe('empty');
    }
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    expect(await readAuditView('sample')).toEqual({
      status: 'read_error',
      entries: [],
      totalValid: 0,
      truncated: false,
      corruptLines: [],
      excludedCount: 0,
    });
  });

  it('AC-001/003/009/011/012: classifies every line and orders deterministically', async () => {
    write([
      entry({ occurredAt: 'invalid' }),
      entry(),
      '{}',
      entry(),
      entry({ occurredAt: '2027-01-01' }),
      entry({ projectId: 'other' }),
      entry({ projectId: null }),
      entry({ occurredAt: 'invalid' }),
      '{"tail":',
    ]);
    const result = await readAuditView('sample');
    expect(result.entries.map((v) => v.line)).toEqual([5, 4, 2, 8, 1]);
    expect(result.corruptLines).toEqual([3, 9]);
    expect(result.excludedCount).toBe(2);
    expect(result.totalValid).toBe(5);
  });

  it('AC-010: all corrupt includes valid JSON lacking outcome.status', async () => {
    write(['broken', { ...entry(), outcome: {} }]);
    expect(await readAuditView('sample')).toMatchObject({
      status: 'ok',
      entries: [],
      corruptLines: [1, 2],
    });
  });

  it.each([500, 501, 520])('AC-017/018/022: bounds %i entries with whole-file counts', async (count) => {
    write([
      'bad',
      entry({ projectId: 'other' }),
      ...Array.from({ length: count }, () => entry()),
    ]);
    const result = await readAuditView('sample');
    expect(result.entries).toHaveLength(500);
    expect(result.entries[0].line).toBe(count + 2);
    expect(result.entries.at(-1)!.line).toBe(count - 497);
    expect(result).toMatchObject({
      totalValid: count,
      truncated: count > 500,
      corruptLines: [1],
      excludedCount: 1,
    });
  });

  it('AC-002/014/015: projects, redacts all strings and leaves logs byte-identical', async () => {
    const discovery = path.join(home, '.pixel-agents', 'server.json');
    fs.writeFileSync(discovery, JSON.stringify({ token: 'fixture-discovery-token' }));
    write([
      entry({
        action: 'fixture-discovery-token',
        outcome: {
          status: 'ok',
          reason: 'sk-secret',
          detail: 'ghp_secret',
          model: 'fixture-discovery-token',
        },
      }),
    ]);
    const machine = new AuditLog().file(null);
    fs.writeFileSync(machine, 'machine sentinel');
    const hash = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    const before = [hash(file), hash(machine), fs.readdirSync(path.dirname(file))];
    const append = vi.spyOn(AuditLog.prototype, 'append');
    const result = await readAuditView('sample');
    const row = result.entries[0];
    expect(row).toMatchObject({
      actorId: null,
      resourceId: null,
      taskKey: null,
      executionId: null,
      policyDecision: null,
      outcome: {
        tier: null,
        executor: null,
        code: null,
        reason: '[REDACTED]',
        detail: '[REDACTED]',
      },
    });
    expect(Object.keys(row).sort()).toEqual(
      [
        'line',
        'occurredAt',
        'actorType',
        'actorId',
        'action',
        'resourceType',
        'resourceId',
        'policyDecision',
        'riskLevel',
        'outcome',
        'taskKey',
        'executionId',
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /never-display|sk-secret|ghp_secret|fixture-discovery-token/,
    );
    expect([hash(file), hash(machine), fs.readdirSync(path.dirname(file))]).toEqual(before);
    expect(append).not.toHaveBeenCalled();
  });
});
