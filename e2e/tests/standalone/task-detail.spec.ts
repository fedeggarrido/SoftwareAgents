import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, test as base } from '../../fixtures/standalone';
import { launchStandalone } from '../../helpers/standalone';

const test = base.extend<{ taskPhase: 'READY' | 'RUNNING' | 'DONE' }>({
  taskPhase: ['READY', { option: true }],
  standalone: async ({ page, taskPhase }, use, testInfo) => {
    const homeDir = testInfo.outputPath('home');
    const workspaceDir = testInfo.outputPath('workspace');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, '.softwareagents'), { recursive: true });
    execFileSync('git', ['init', workspaceDir], { windowsHide: true, stdio: 'pipe' });
    fs.writeFileSync(
      path.join(workspaceDir, '.softwareagents/project.yaml'),
      JSON.stringify({
        apiVersion: 'softwareagents.io/v1alpha1',
        kind: 'Project',
        id: 'task-detail-e2e',
        name: 'Pedidos',
        repo: { remote: 'local', defaultBranch: 'main' },
        brain: { path: '.softwareagents/brain' },
      }),
    );
    // Initialize through the built CLI so the fixture uses the runtime's current schema.
    execFileSync(
      process.execPath,
      [path.resolve(__dirname, '../../../dist/cli.js'), 'task', 'list', '--json'],
      {
        cwd: workspaceDir,
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
        windowsHide: true,
        stdio: 'pipe',
      },
    );
    const directory = path.join(workspaceDir, '.git/softwareagents');
    const db = new DatabaseSync(path.join(directory, 'work.sqlite3'));
    try {
      db.exec(
        "INSERT INTO features(project_id,key,doc_path,git_sha,status,title) VALUES ('task-detail-e2e','FEAT-001','spec.md','fixture','approved','Pedidos');",
      );
      for (const [key, title] of [
        ['FEAT-001-T01', 'Crear recibos'],
        ['FEAT-001-T02', 'Enviar recibos'],
        ['FEAT-001-T03', 'Consultar recibos'],
      ]) {
        const running = key === 'FEAT-001-T01' && taskPhase === 'RUNNING';
        db.prepare(
          `INSERT INTO tasks(project_id,feature_key,key,type,status,priority,version,attempt,max_attempts,created_at,updated_at,declaration,lease_owner,lease_expires_at)
          VALUES ('task-detail-e2e','FEAT-001',?,'code',?,0,1,0,3,'2026-11-11','2026-11-11',?,?,?)`,
        ).run(
          key,
          key === 'FEAT-001-T01' ? taskPhase : 'READY',
          JSON.stringify({ title, description: 'Emitir recibos legibles para cada pedido.' }),
          running ? 'fixture-worker' : null,
          running ? new Date(Date.now() + 3600000).toISOString() : null,
        );
      }
      db.exec(
        "INSERT INTO task_dependencies VALUES ('task-detail-e2e','FEAT-001-T02','FEAT-001-T01');",
      );
    } finally {
      db.close();
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

function inspect(workspace: string, query: string) {
  const db = new DatabaseSync(path.join(workspace, '.git/softwareagents/work.sqlite3'), {
    readOnly: true,
  });
  try {
    return db.prepare(query).all();
  } finally {
    db.close();
  }
}

test.describe('Standalone / task detail', () => {
  test('opens within Trabajo and requires a second confirmation after listing the impact @area:standalone', async ({
    page,
    standalone,
  }) => {
    await page.getByRole('button', { name: 'Trabajo', exact: true }).click();
    await page.locator('[data-task-key="FEAT-001-T01"]').click();
    const detail = page.getByTestId('task-detail');
    await expect(detail.getByRole('heading', { name: 'Crear recibos', exact: true })).toBeVisible();
    await expect(detail.getByText('Emitir recibos legibles para cada pedido.')).toBeVisible();
    await expect(detail).not.toContainText(/WAITING_HUMAN|desconocido|[a-f0-9]{8}-[a-f0-9]{4}-/);
    await detail.getByRole('button', { name: 'Pedir un cambio', exact: true }).click();
    await detail
      .getByLabel('Especificación editada')
      .fill('Incluir el total del pedido en el recibo.');
    await detail.getByRole('button', { name: 'Revisar impacto' }).click();
    await expect(detail.getByTestId('task-change-impact')).toContainText('Enviar recibos');
    await expect(detail.getByTestId('task-change-impact')).toContainText('Consultar recibos');
    expect(inspect(standalone.workspaceDir, 'SELECT * FROM human_decisions')).toHaveLength(0);
    await detail.getByRole('button', { name: 'Confirmar cambio', exact: true }).click();
    await expect(detail.getByText('Incluir el total del pedido en el recibo.')).toBeVisible();
    await expect(detail.getByText('Aprobar especificación', { exact: true })).toBeVisible();
    expect(
      inspect(standalone.workspaceDir, "SELECT status FROM tasks WHERE key = 'FEAT-001-T01'"),
    ).toEqual([{ status: 'WAITING_HUMAN' }]);
    await detail.getByRole('button', { name: 'Volver a Trabajo' }).click();
    await expect(page.getByTestId('task-detail')).toHaveCount(0);
  });

  test('read-only access explains the change path and cannot submit @area:standalone', async ({
    page,
    standalone,
  }) => {
    const context = await page.context().browser()!.newContext();
    try {
      const spectator = await context.newPage();
      await spectator.goto(standalone.hostUrl);
      await spectator.getByRole('button', { name: 'Trabajo', exact: true }).click();
      await spectator.locator('[data-task-key="FEAT-001-T01"]').click();
      const detail = spectator.getByTestId('task-detail');
      await expect(detail.getByText(/Editarás la especificación/)).toBeVisible();
      await expect(
        detail.getByRole('button', { name: 'Pedir un cambio', exact: true }),
      ).toBeDisabled();
      expect(inspect(standalone.workspaceDir, 'SELECT * FROM human_decisions')).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  test.describe('running work', () => {
    test.use({ taskPhase: 'RUNNING' });
    test('records a request while preserving the active lease @area:standalone', async ({
      page,
      standalone,
    }) => {
      const before = inspect(
        standalone.workspaceDir,
        "SELECT * FROM tasks WHERE key = 'FEAT-001-T01'",
      );
      await page.getByRole('button', { name: 'Trabajo', exact: true }).click();
      await page.locator('[data-task-key="FEAT-001-T01"]').click();
      const detail = page.getByTestId('task-detail');
      await detail.getByRole('button', { name: 'Pedir un cambio', exact: true }).click();
      await detail.getByLabel('Qué quieres cambiar').fill('Revisar el formato del recibo.');
      await detail.getByRole('button', { name: 'Revisar impacto' }).click();
      await detail.getByRole('button', { name: 'Confirmar cambio', exact: true }).click();
      await expect(detail.getByText('Revisar el formato del recibo.')).toBeVisible();
      expect(
        inspect(standalone.workspaceDir, "SELECT * FROM tasks WHERE key = 'FEAT-001-T01'"),
      ).toEqual(before);
    });
  });

  test.describe('completed work', () => {
    test.use({ taskPhase: 'DONE' });
    test('creates a linked draft follow-up after confirmation @area:standalone', async ({
      page,
      standalone,
    }) => {
      await page.getByRole('button', { name: 'Trabajo', exact: true }).click();
      await page.locator('summary').filter({ hasText: 'Hechas' }).click();
      await page.locator('[data-task-key="FEAT-001-T01"]').click();
      const detail = page.getByTestId('task-detail');
      await detail.getByRole('button', { name: 'Pedir un cambio', exact: true }).click();
      await detail.getByLabel('Qué quieres cambiar').fill('Añadir recibos en otro idioma.');
      await detail.getByRole('button', { name: 'Revisar impacto' }).click();
      await detail.getByRole('button', { name: 'Confirmar cambio', exact: true }).click();
      await expect(
        detail.getByText('Tarea de seguimiento creada, pendiente de planificar.'),
      ).toBeVisible();
      expect(
        inspect(standalone.workspaceDir, "SELECT status FROM tasks WHERE key = 'FOLLOWUP-001'"),
      ).toEqual([{ status: 'DRAFT' }]);
      expect(
        inspect(
          standalone.workspaceDir,
          "SELECT json_extract(declaration, '$.followUpOf') AS origin FROM tasks WHERE key = 'FOLLOWUP-001'",
        ),
      ).toEqual([{ origin: 'FEAT-001-T01' }]);
    });
  });
});
