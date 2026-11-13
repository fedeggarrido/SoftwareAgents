import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';

test.describe('Standalone / new project', () => {
  test('creates and opens a local project through the wizard in an isolated parent @area:standalone', async ({
    page,
    standalone,
  }) => {
    fs.mkdirSync(path.join(standalone.tmpHome, 'projects'));
    // The server reports canonical paths; Windows runners hand out 8.3 short temp names.
    const parent = fs.realpathSync.native(path.join(standalone.tmpHome, 'projects'));
    await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
    await page.getByRole('button', { name: 'Nuevo proyecto', exact: true }).click();
    const wizard = page.getByRole('dialog', { name: 'Nuevo proyecto', exact: true });
    await wizard.getByLabel('Nombre del proyecto', { exact: true }).fill('Agenda del barrio');
    await wizard.getByRole('button', { name: 'Siguiente', exact: true }).click();
    await wizard.getByLabel('Carpeta principal', { exact: true }).fill(parent);
    await wizard.getByRole('button', { name: 'Elegir carpeta', exact: true }).click();
    await expect(wizard.getByRole('region', { name: 'Explorar carpetas' })).toBeVisible();
    await wizard.getByRole('button', { name: 'Guardar como predeterminada', exact: true }).click();
    await expect(wizard.getByText('Carpeta predeterminada guardada.')).toBeVisible();
    await wizard.getByRole('button', { name: 'Comprobar carpeta', exact: true }).click();
    await expect(wizard.getByLabel('Alojamiento', { exact: true })).toHaveValue('local');
    await wizard.getByRole('button', { name: 'Siguiente', exact: true }).click();
    await expect(
      wizard.getByText(path.join(parent, 'agenda-del-barrio'), { exact: true }),
    ).toBeVisible();
    await wizard.getByRole('button', { name: 'Crear proyecto', exact: true }).click();
    await expect(
      wizard.getByRole('heading', { name: 'Proyecto creado', exact: true }),
    ).toBeVisible();
    await expect(wizard.getByText('Alojamiento elegido Solo local')).toBeVisible();
    await wizard.getByRole('button', { name: 'Ver el proyecto', exact: true }).click();
    await page.getByRole('button', { name: 'Proyecto', exact: true }).click();
    await expect(
      page
        .getByRole('region', { name: 'Resumen del proyecto', exact: true })
        .getByRole('heading', { name: 'Agenda del barrio', exact: true }),
    ).toBeVisible();
  });
});
