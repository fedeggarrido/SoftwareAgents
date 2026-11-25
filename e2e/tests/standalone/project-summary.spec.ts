import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { expect, test as base } from '../../fixtures/standalone';
import { launchStandalone } from '../../helpers/standalone';
import { setSettings } from '../../helpers/webview';

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
    await expect(
      page.locator('.bottom-toolbar').getByRole('button', { name: 'Decisiones', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
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
      const qa = workflow.getByRole('button', {
        name: 'Ver Pruebas en Trabajo pendiente',
        exact: true,
      });
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
      const backlog = page.getByRole('region', { name: 'Trabajo pendiente', exact: true });
      await expect(backlog.getByText('Etapa · Pruebas', { exact: true })).toBeVisible();
      await expect(backlog.getByTestId('backlog-card')).toHaveCount(1);
      await expect(backlog.getByTestId('backlog-card')).toContainText('FEAT-001-T02');
      await backlog
        .getByRole('button', { name: 'Ver todo el trabajo pendiente', exact: true })
        .click();
      await expect(backlog.getByTestId('backlog-card')).toHaveCount(3);
      const project = page.locator('.bottom-toolbar').getByRole('button', {
        name: 'Proyecto',
        exact: true,
      });
      if (!(await project.isVisible()))
        await page.getByRole('button', { name: 'Más', exact: true }).click();
      await project.click();
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
      workflow.getByRole('button', { name: 'Ver Pruebas en Trabajo pendiente', exact: true }),
    ).toContainText('Hecho');
    await expect(
      workflow.getByRole('button', { name: 'Ver Entrega en Trabajo pendiente', exact: true }),
    ).toContainText('Hecho');
    await workflow
      .getByRole('button', { name: 'Ver Idea en Trabajo pendiente', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Trabajo pendiente', exact: true }),
    ).toContainText('Sin tareas en esta etapa.');
  });

  test('completes and corrects an idea with visible actions on desktop and mobile @area:standalone', async ({
    page,
    standalone,
  }) => {
    expect(standalone.workspaceDir).toBeTruthy();
    for (const viewport of [
      { width: 1024, height: 768 },
      { width: 390, height: 768 },
    ]) {
      await page.setViewportSize(viewport);
      await page.getByRole('button', { name: 'Nueva idea', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Nueva idea', exact: true });
      await dialog
        .getByLabel('Tu idea', { exact: true })
        .fill('Recordar las citas de la peluquería');
      await dialog.getByRole('button', { name: 'Siguiente', exact: true }).click();
      const answer = dialog.getByLabel('Tu respuesta (opcional)', { exact: true });
      await expect(answer).toBeFocused();
      await expect(
        dialog.getByText('Ejemplo: recordar las citas para evitar olvidos.'),
      ).toBeVisible();
      await expect(dialog.getByRole('radio')).toHaveCount(0);
      await expect(dialog.getByRole('progressbar')).toHaveAccessibleName('Paso 2 de 9');
      await answer.fill('Evitar olvidos');
      await dialog.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await dialog.getByRole('button', { name: 'Decide tú el resto', exact: true }).click();
      await expect(
        dialog.getByRole('heading', { name: 'Revisar entrevista', exact: true }),
      ).toBeFocused();
      await dialog.getByRole('button', { name: 'Editar: Objetivo', exact: true }).click();
      await expect(answer).toHaveValue('Evitar olvidos');
      await answer.fill('Reducir citas olvidadas');
      await dialog.getByRole('button', { name: 'Volver a la revisión', exact: true }).click();
      await dialog.getByRole('button', { name: 'Editar: Usuarios', exact: true }).click();
      await answer.fill('La peluquera');
      await dialog.getByRole('button', { name: 'Volver a la revisión', exact: true }).click();
      await expect(dialog).toContainText('Reducir citas olvidadas');
      await expect(dialog).toContainText('La peluquera');
      await expect(dialog.getByText(/^Decide tú:/)).toHaveCount(1);
      await expect(dialog).not.toContainText('openQuestions');
      const footer = dialog.locator('.idea-dialog-footer');
      const before = await footer.boundingBox();
      expect(before).not.toBeNull();
      expect(before!.y).toBeGreaterThanOrEqual(0);
      expect(before!.y + before!.height).toBeLessThanOrEqual(viewport.height);
      await dialog.locator('.idea-dialog-scroll').evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      expect(await footer.boundingBox()).toEqual(before);
      await dialog.getByRole('button', { name: 'Guardar idea', exact: true }).click();
      await expect(dialog.getByText(/Idea guardada:/)).toBeVisible();
      await footer.getByRole('button', { name: 'Cerrar', exact: true }).click();
    }
  });

  test('SA-123 readable feature cards and completed tasks @area:standalone', async ({
    page,
    standalone,
  }) => {
    const file = path.join(standalone.workspaceDir, '.git/softwareagents/work.sqlite3');
    const db = new DatabaseSync(file);
    try {
      db.exec("UPDATE tasks SET status = 'DONE' WHERE project_id = 'summary-e2e'");
    } finally {
      db.close();
    }
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 390) await page.getByRole('button', { name: 'Más', exact: true }).click();
      await page.getByRole('button', { name: 'Funcionalidades', exact: true }).click();
      const panel = page.getByRole('region', { name: 'Funcionalidades', exact: true });
      const card = panel.locator('.feature-row').filter({ hasText: 'Recibos' });
      await expect(card.locator('.status-chip')).toHaveText(
        'Tareas completadas; cierre sin confirmar',
      );
      await expect(card).not.toContainText('En desarrollo');
      await expect(panel).not.toContainText('Esta oficina no tiene un proyecto');
      await expect(card.getByText(/Siguiente acción:/)).toBeVisible();
      await expect(card.getByText(/Coste estimado API:/)).toContainText('sin datos');
      await expect(card.getByRole('progressbar')).not.toBeVisible();
      const details = card.locator('.feature-details');
      await expect(details).not.toHaveAttribute('open');
      await details.locator('summary').click();
      await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '3/3');
      const idea = panel.locator('.idea-row');
      await expect(idea.locator('.idea-text')).toHaveText('Consultar los pedidos de la tienda');
      await idea.getByText('Leer resumen de la idea', { exact: true }).click();
      await expect(idea.locator('.idea-description p')).toHaveText(
        'Consultar los pedidos de la tienda',
      );
      await idea.getByText('Detalles', { exact: true }).click();
      await expect(idea.getByRole('button', { name: 'Copiar comando', exact: true })).toBeVisible();
      await card.getByRole('button', { name: 'Ver plan', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Plan de funcionalidad' });
      await expect(dialog.getByText(/No se pudo leer el plan:/)).toContainText(
        'No se conoce la causa concreta',
      );
      await expect(
        dialog.getByRole('button', { name: 'Actualizar plan', exact: true }),
      ).toBeEnabled();
      await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
      await page.getByRole('button', { name: 'Cerrar ventana', exact: true }).click();
    }
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
      await page.getByRole('button', { name: 'Cerrar ventana', exact: true }).click();
      await page.getByRole('button', { name: 'M\u00e1s', exact: true }).click();
      await page.getByRole('button', { name: 'Funcionalidades', exact: true }).click();
      const instructions = page.locator('.terminal-instructions');
      await expect(instructions).toContainText('puedes supervisar el proyecto');
      await expect(instructions.locator('code')).toBeHidden();
      await instructions.getByText('Comando para el ordenador', { exact: true }).click();
      await expect(instructions.locator('code')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
  });
});

for (const width of [375, 390]) {
  test(`mobile supervision at ${width}px keeps controls separate @area:standalone`, async ({
    page,
    standalone,
  }) => {
    void standalone;
    await setSettings(page, { hooksEnabled: true });
    await page.setViewportSize({ width, height: 812 });
    const hud = page.getByTestId('company-hud');
    const zoom = page.getByTestId('zoom-controls');
    await expect(hud).toBeVisible();
    await expect(zoom).toBeVisible();
    await expect(
      page.getByText('Detecci\u00f3n instant\u00e1nea activa', { exact: true }),
    ).toBeVisible();

    const boxes = await Promise.all([
      hud.boundingBox(),
      page.locator('.office-notices').boundingBox(),
      zoom.boundingBox(),
    ]);
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      expect(a).not.toBeNull();
      if (!a) throw new Error('Missing office control');
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.x + a.width).toBeLessThanOrEqual(width);
      for (const b of boxes.slice(i + 1)) {
        if (!b) throw new Error('Missing office control');
        expect(
          a.x + a.width <= b.x ||
            b.x + b.width <= a.x ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y,
        ).toBe(true);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const reduce = zoom.getByRole('button', { name: 'Reducir (Ctrl + rueda)', exact: true });
    await expect(reduce).toBeDisabled();
    await page.setViewportSize({ width: 700, height: 812 });
    await expect(reduce).toBeEnabled();
    await page.setViewportSize({ width, height: 812 });
    await expect(reduce).toBeDisabled();
    await zoom.getByRole('button', { name: 'Ampliar (Ctrl + rueda)', exact: true }).click();
    await page.setViewportSize({ width: width + 1, height: 812 });
    await expect(reduce).toBeEnabled();
    const dock = page.getByRole('navigation', { name: 'Controles de la oficina' });
    for (const name of ['Proyecto', 'Trabajo pendiente', 'Decisiones']) {
      if (name === 'Proyecto')
        await dock.getByRole('button', { name: 'M\u00e1s', exact: true }).click();
      const button = dock.getByRole('button', { name, exact: true });
      const box = await button.boundingBox();
      if (!box) throw new Error('Missing lower navigation');
      expect(box.y).toBeGreaterThan(812 / 2);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
      await button.click();
      await expect(page.locator('.panel-window-mobile')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.getByRole('button', { name: 'Cerrar ventana', exact: true }).click();
    }
  });
}
