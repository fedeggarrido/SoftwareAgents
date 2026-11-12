import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, test as base } from '../../fixtures/standalone';
import { launchStandalone } from '../../helpers/standalone';

const test = base.extend<{ summarySeed: 'mixed' | 'empty' }>({
  summarySeed: ['mixed', { option: true }],
  standalone: async ({ page, summarySeed }, use, testInfo) => {
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
        id: 'summary-e2e',
        name: 'Tienda de barrio',
        repo: { remote: 'local', defaultBranch: 'main' },
        brain: { path: '.softwareagents/brain' },
      }),
    );
    if (summarySeed === 'mixed') {
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
      const db = new DatabaseSync(path.join(workspaceDir, '.git/softwareagents/work.sqlite3'));
      try {
        db.exec(
          "INSERT INTO features(project_id,key,doc_path,git_sha,status,title) VALUES ('summary-e2e','FEAT-001','spec.md','fixture','approved','Recibos');",
        );
        for (const [key, title, status] of [
          ['FEAT-001-T01', 'Crear recibos', 'DONE'],
          ['FEAT-001-T02', 'Enviar recibos', 'QA'],
          ['FEAT-001-T03', 'Consultar recibos', 'READY'],
        ])
          db.prepare(
            `INSERT INTO tasks(project_id,feature_key,key,type,status,priority,version,attempt,max_attempts,created_at,updated_at,declaration)
          VALUES ('summary-e2e','FEAT-001',?,'code',?,0,1,0,3,'2026-11-01','2026-11-02',?)`,
          ).run(key, status, JSON.stringify({ title }));
        db.exec(
          "INSERT INTO task_dependencies VALUES ('summary-e2e','FEAT-001-T03','FEAT-001-T01');",
        );
      } finally {
        db.close();
      }
      const ideasDir = path.join(workspaceDir, '.softwareagents/ideas/summary-e2e');
      fs.mkdirSync(ideasDir, { recursive: true });
      fs.writeFileSync(
        path.join(ideasDir, 'FEAT-002.md'),
        '# Idea\n\n    Consultar pedidos\n\n## Respuestas\n\n### Objetivo\n\n    Consultar los pedidos de la tienda\n\n## Supuestos\n\nNinguno.\n',
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

test.describe('Standalone / project summary', () => {
  test('shows the app, real work and next steps through the office window without writes @area:standalone', async ({
    page,
    standalone,
  }) => {
    const file = path.join(standalone.workspaceDir, '.git/softwareagents/work.sqlite3');
    const before = fs.readFileSync(file);
    await page.getByRole('button', { name: 'Proyecto', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Resumen del proyecto', exact: true });
    await expect(panel.getByRole('heading', { name: 'Tienda de barrio' })).toBeVisible();
    await expect(
      panel.getByText('Consultar los pedidos de la tienda', { exact: true }),
    ).toBeVisible();
    await expect(panel.getByText('1 hecha · 1 en curso · 1 pendiente')).toBeVisible();
    await expect(panel.locator('.project-summary-features .status-chip')).toContainText('En curso');
    await expect(panel.getByText('Sin datos de coste o consumo registrados.')).toBeVisible();
    await expect(panel.getByText('Preparada para empezar · Consultar recibos')).toBeVisible();
    await panel.getByRole('button', { name: 'Actualizar', exact: true }).click();
    await expect(panel.getByRole('heading', { name: 'Tienda de barrio' })).toBeVisible();
    await expect(panel.locator('input,textarea,select')).toHaveCount(0);
    expect(fs.readFileSync(file)).toEqual(before);
    await panel.getByRole('button', { name: 'Ver decisiones', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Decisiones', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('denies unprivileged access without project details @area:standalone', async ({
    page,
    standalone,
  }) => {
    const context = await page.context().browser()!.newContext();
    try {
      const spectator = await context.newPage();
      await spectator.goto(standalone.hostUrl);
      await spectator.getByRole('button', { name: 'Proyecto', exact: true }).click();
      const panel = spectator.getByRole('region', { name: 'Resumen del proyecto', exact: true });
      await expect(panel.getByRole('alert')).toContainText('Acceso denegado');
      await expect(panel).not.toContainText('Tienda de barrio');
      await expect(panel).not.toContainText('Consultar los pedidos de la tienda');
    } finally {
      await context.close();
    }
  });

  test('filters Trabajo from the live workflow at 390, 1024 and 1440 px @area:standalone', async ({
    page,
    standalone,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Proyecto', exact: true }).click();
    const workflow = page.getByRole('region', {
      name: 'Flujo de trabajo del proyecto',
      exact: true,
    });
    for (const width of [390, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await workflow.locator('summary').click();
      const qa = workflow.getByRole('button', { name: 'Ver QA en Trabajo', exact: true });
      await expect(qa).toContainText('Activo');
      await expect(qa).toContainText('1 tarea');
      expect(await workflow.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(
        await qa.evaluate((element) => element.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(44);
      expect(
        await qa
          .locator('.status-chip')
          .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
      ).toBeGreaterThanOrEqual(14);
      expect(await qa.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
      await qa.click();
      const backlog = page.getByRole('region', { name: 'Trabajo', exact: true });
      await expect(backlog.getByText('Etapa · QA', { exact: true })).toBeVisible();
      await expect(backlog.getByTestId('backlog-card')).toHaveCount(1);
      await expect(backlog.getByTestId('backlog-card')).toContainText('FEAT-001-T02');
      await backlog.getByRole('button', { name: 'Ver todo el trabajo', exact: true }).click();
      await expect(backlog.getByTestId('backlog-card')).toHaveCount(3);
      await page.getByRole('tab', { name: 'Proyecto', exact: true }).click();
    }
    await workflow.locator('summary').click();
    const db = new DatabaseSync(
      path.join(standalone.workspaceDir, '.git/softwareagents/work.sqlite3'),
    );
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare(
        "UPDATE tasks SET status = 'DONE', version = 2, updated_at = ? WHERE project_id = 'summary-e2e' AND key = 'FEAT-001-T02'",
      ).run(new Date().toISOString());
      db.prepare(
        "INSERT INTO domain_events(project_id,task_key,type,from_status,to_status,task_version,attempt,reason,actor,created_at) VALUES ('summary-e2e','FEAT-001-T02','TASK_TRANSITIONED','QA','DONE',2,0,'fixture','human',?)",
      ).run(new Date().toISOString());
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    await expect(
      workflow.getByRole('button', { name: 'Ver QA en Trabajo', exact: true }),
    ).toContainText('Hecho');
    await expect(
      workflow.getByRole('button', { name: 'Ver Entrega en Trabajo', exact: true }),
    ).toContainText('Hecho');
    await workflow.getByRole('button', { name: 'Ver Idea en Trabajo', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Trabajo', exact: true })).toContainText(
      'Sin tareas en esta etapa.',
    );
  });

  test.describe('empty project on mobile', () => {
    test.use({ summarySeed: 'empty' });
    test('explains how to start from the mobile dock @area:standalone', async ({
      page,
      standalone,
    }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.getByRole('button', { name: 'Más', exact: true }).click();
      await page.getByRole('button', { name: 'Proyecto', exact: true }).click();
      const panel = page.getByRole('region', { name: 'Resumen del proyecto', exact: true });
      await expect(panel.getByRole('heading', { name: 'Tienda de barrio' })).toBeVisible();
      await expect(
        panel.getByText(
          /Crea una Nueva idea desde la barra de la oficina para definir qué construir/,
        ),
      ).toBeVisible();
      await expect(panel.locator('.project-workflow .status-chip')).toHaveCount(8);
      await expect(panel.locator('.project-workflow .status-chip')).toHaveText(
        Array(8).fill('Sin trabajo'),
      );
      await expect(panel).not.toContainText('USD');
    });
  });
});
