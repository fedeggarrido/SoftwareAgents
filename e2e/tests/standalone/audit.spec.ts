import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test as base } from '../../fixtures/standalone';
import { launchStandalone } from '../../helpers/standalone';

const secret = 'ghp_auditFixtureOnly123456789';
const inputHash = 'audit-input-hash-must-never-reach-dom';

function entry(index: number) {
  return {
    id: `entry-${index}`,
    occurredAt: new Date(Date.UTC(2026, 9, 16, 10, 0, 5 + index)).toISOString(),
    projectId: 'audit-e2e',
    actorType: 'human',
    actorId: 'fixture-operator',
    action: index < 20 ? 'old-only' : index % 2 ? 'review' : 'inspect',
    resourceType: 'task',
    resourceId: `resource-${index}`,
    policyDecision: { outcome: 'allow', reason: 'fixture policy' },
    riskLevel: 'low',
    inputHash,
    outcome: {
      status: index % 3 ? 'success' : 'failure',
      reason: `reason-${index} ${secret}`,
      detail: `detail-${index} ${secret}`,
      tier: 'fixture-tier',
      executor: 'fixture-executor',
      model: 'fixture-model',
      code: 'fixture-code',
    },
    taskKey: `TASK-${index}`,
    executionId: `execution-${index}`,
  };
}

const test = base.extend<{ auditSeed: boolean }>({
  auditSeed: [true, { option: true }],
  standalone: async ({ page, auditSeed }, use, testInfo) => {
    const homeDir = testInfo.outputPath('home');
    const workspaceDir = testInfo.outputPath('workspace');
    fs.mkdirSync(path.join(workspaceDir, '.softwareagents'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, '.softwareagents', 'project.yaml'),
      'apiVersion: softwareagents.io/v1alpha1\nkind: Project\nid: audit-e2e\nname: Audit fixture\nrepo:\n  remote: https://example.invalid/audit.git\n  defaultBranch: main\nbrain:\n  path: .softwareagents/brain\n',
    );
    if (auditSeed) {
      const dir = path.join(homeDir, '.pixel-agents', 'audit');
      fs.mkdirSync(dir, { recursive: true });
      // Both diagnostic lines precede the oldest loaded entry. These are audit
      // fixtures, not Claude transcripts; no hooks or sessions are simulated.
      fs.writeFileSync(
        path.join(dir, 'audit-e2e.jsonl'),
        [
          'corrupt-private-content',
          JSON.stringify({ ...entry(0), projectId: 'other-project' }),
          ...Array.from({ length: 520 }, (_, index) => JSON.stringify(entry(index))),
        ].join('\n') + '\n',
      );
    }
    const session = await launchStandalone(page, { homeDir, workspaceDir });
    try {
      await use(session);
    } finally {
      await testInfo.attach('standalone-host-log', {
        body: session.getHostLogs(),
        contentType: 'text/plain',
      });
      await session.cleanup();
    }
  },
});

async function openAudit(page: Page) {
  await page.getByRole('button', { name: 'Auditoría', exact: true }).click();
  return page.getByRole('region', { name: 'Auditoría', exact: true });
}

test.describe('Standalone / audit', () => {
  test.use({ timezoneId: 'Europe/Madrid', locale: 'en-US' });

  test('reads, filters and expands the latest 500 without writing @area:standalone', async ({
    page,
    standalone,
  }) => {
    const file = path.join(standalone.tmpHome, '.pixel-agents', 'audit', 'audit-e2e.jsonl');
    const digest = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const before = digest();
    const panel = await openAudit(page);
    const rows = panel.locator('article');
    await expect(rows).toHaveCount(500);
    // Assert the entire ordering, not merely the endpoints.
    await expect(rows.locator('dd').filter({ hasText: /^task \/ resource-\d+$/ })).toHaveText(
      Array.from({ length: 500 }, (_, index) => `task / resource-${519 - index}`),
    );
    const notices = async () => {
      await expect(
        panel.getByText('mostrando las 500 más recientes de 520', { exact: true }),
      ).toBeVisible();
      await expect(panel.getByText('1 líneas corruptas (1)', { exact: true })).toBeVisible();
      await expect(
        panel.getByText('1 entradas excluidas por no pertenecer al Project', { exact: true }),
      ).toBeVisible();
    };
    await notices();
    await expect(panel.getByLabel('Acción').locator('option')).toHaveText([
      'Todas',
      'inspect',
      'review',
    ]);
    const first = rows.first();
    await expect(first).toContainText('human / fixture-operator');
    await expect(first).toContainText('allow / fixture policy');
    await expect(first).toContainText('TASK-519');
    await expect(first).toContainText('execution-519');
    await expect(first).toContainText('reason-519 [REDACTED]');
    const date = first.locator('[title="2026-10-16 10:08:44 UTC"]');
    await expect(date).toHaveText('2026-10-16 12:08:44');
    await date.hover();
    await expect(first.locator('details')).not.toHaveAttribute('open', '');
    await expect(first.getByText('fixture-tier', { exact: true })).not.toBeVisible();
    await first.getByText('Detalle', { exact: true }).click();
    for (const value of [
      'detail-519 [REDACTED]',
      'fixture-tier',
      'fixture-executor',
      'fixture-model',
      'fixture-code',
      'low',
    ]) {
      await expect(first.getByText(value, { exact: true })).toBeVisible();
    }
    const dom = await panel.innerHTML();
    for (const hidden of [
      secret,
      inputHash,
      'inputHash',
      'corrupt-private-content',
      'other-project',
    ]) {
      expect(dom).not.toContain(hidden);
    }
    await panel.getByLabel('Acción').selectOption({ label: 'review' });
    await expect(rows).toHaveCount(250);
    await notices();
    await panel.getByLabel('Resultado').selectOption({ label: 'failure' });
    const matching = Array.from({ length: 500 }, (_, i) => 519 - i).filter(
      (i) => i % 2 === 1 && i % 3 === 0,
    );
    await expect(rows).toHaveCount(matching.length);
    await expect(rows.locator('dd').filter({ hasText: /^task \/ resource-\d+$/ })).toHaveText(
      matching.map((i) => `task / resource-${i}`),
    );
    await notices();
    await panel.getByRole('button', { name: 'Quitar filtros', exact: true }).click();
    await expect(rows).toHaveCount(500);
    await notices();
    await expect(
      panel.getByRole('button', {
        name: /crear|editar|borrar|exportar|retenci|create|edit|delete|export|retention/i,
      }),
    ).toHaveCount(0);
    expect(digest()).toBe(before);
  });

  test('untokened URL denies access without entries or counts @area:standalone', async ({
    page,
    standalone,
  }) => {
    const file = path.join(standalone.tmpHome, '.pixel-agents', 'audit', 'audit-e2e.jsonl');
    const before = fs.readFileSync(file);
    // New context prevents a previously tokened tab from supplying credentials.
    const context = await page.context().browser()!.newContext();
    try {
      const spectator = await context.newPage();
      await spectator.goto(standalone.hostUrl);
      const panel = await openAudit(spectator);
      await expect(panel.getByRole('status')).toHaveText('Acceso denegado a la auditoría');
      await expect(panel.locator('article')).toHaveCount(0);
      await expect(
        panel.getByText(/más recientes|líneas corruptas|entradas excluidas/),
      ).toHaveCount(0);
      await expect(panel.getByLabel('Acción').locator('option')).toHaveText(['Todas']);
      await expect(panel.getByLabel('Resultado').locator('option')).toHaveText(['Todos']);
      expect(fs.readFileSync(file)).toEqual(before);
    } finally {
      await context.close();
    }
  });

  test.describe('missing log', () => {
    test.use({ auditSeed: false });
    test('shows the empty state without creating a log @area:standalone', async ({
      page,
      standalone,
    }) => {
      const file = path.join(standalone.tmpHome, '.pixel-agents', 'audit', 'audit-e2e.jsonl');
      expect(fs.existsSync(file)).toBe(false);
      const panel = await openAudit(page);
      await expect(panel.getByRole('status')).toHaveText('No hay entradas de auditoría');
      await expect(panel.locator('article')).toHaveCount(0);
      await expect(
        panel.getByText(/Error de lectura|Acceso denegado|líneas corruptas/),
      ).toHaveCount(0);
      expect(fs.existsSync(file)).toBe(false);
    });
  });
});
