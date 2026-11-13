import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { installFakeGh } from '../../helpers/fake-gh';
import { launchStandalone, type StandaloneSession } from '../../helpers/standalone';

test.describe('Standalone / GitHub hosting', () => {
  for (const mode of ['name_taken', 'unauthenticated']) {
    test(`configures GitHub through an isolated fake gh and handles ${mode} @area:standalone`, async ({
      page,
    }) => {
      // Canonical path: Windows runners hand out 8.3 short temp names.
      const temporary = fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.tmpdir(), 'sa146-e2e-')),
      );
      let session: StandaloneSession | undefined;
      try {
        const home = path.join(temporary, 'home');
        fs.mkdirSync(home);
        const gitConfig = path.join(home, '.gitconfig');
        fs.writeFileSync(
          gitConfig,
          '[user]\n  name = Operador de pruebas\n  email = operador@example.invalid\n',
        );
        const bin = installFakeGh(temporary);
        session = await launchStandalone(page, {
          homeDir: home,
          workspaceDir: path.join(temporary, 'workspace'),
          env: {
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
            GIT_CONFIG_GLOBAL: gitConfig,
            GIT_CONFIG_NOSYSTEM: '1',
            GH_CONFIG_DIR: path.join(home, '.config', 'gh'),
            SA_FAKE_GH_MODE: mode,
          },
        });
        await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
        await page.getByRole('button', { name: 'Nuevo proyecto', exact: true }).click();
        const wizard = page.getByRole('dialog', { name: 'Nuevo proyecto', exact: true });
        await wizard.getByLabel('Nombre del proyecto', { exact: true }).fill('Tienda de pruebas');
        await wizard.getByRole('button', { name: 'Siguiente', exact: true }).click();
        await wizard.getByLabel('Carpeta principal', { exact: true }).fill(home);
        await wizard.getByRole('button', { name: 'Comprobar carpeta', exact: true }).click();
        await wizard.getByLabel('Alojamiento', { exact: true }).selectOption('github_private');
        await wizard.getByRole('button', { name: 'Siguiente', exact: true }).click();
        await wizard.getByRole('button', { name: 'Crear proyecto', exact: true }).click();
        const github = wizard.getByRole('region', { name: 'Alojamiento en GitHub' });
        await github.getByRole('button', { name: 'Configurar GitHub', exact: true }).click();
        if (mode === 'unauthenticated') {
          await expect(github.getByRole('alert')).toContainText(
            'gh auth login en tu propia terminal',
          );
          await expect(
            github.getByRole('button', { name: 'Confirmar y crear repositorio', exact: true }),
          ).toHaveCount(0);
        } else {
          await expect(github.getByText('Se creará en la cuenta operador-pruebas')).toBeVisible();
          await expect(github.getByLabel('Nombre del repositorio')).toHaveValue(
            'tienda-de-pruebas',
          );
          await expect(github.getByLabel('Visibilidad')).toHaveValue('private');
          await github.getByLabel('Propietario').selectOption('equipo-pruebas');
          await github.getByLabel('Visibilidad').selectOption('public');
          await github.getByRole('button', { name: 'Revisar creación', exact: true }).click();
          await expect(
            github.getByText('Repositorio equipo-pruebas/tienda-de-pruebas · Público'),
          ).toBeVisible();
          await github
            .getByRole('button', { name: 'Confirmar y crear repositorio', exact: true })
            .click();
          await expect(github.getByRole('alert')).toContainText(
            'Ya existe un repositorio con ese nombre',
          );
          await github.getByRole('button', { name: 'Reintentar', exact: true }).click();
          await expect(github.getByLabel('Nombre del repositorio')).toBeVisible();
          await expect(
            github.getByRole('button', { name: 'Confirmar y crear repositorio', exact: true }),
          ).toHaveCount(0);
        }
        await wizard.getByRole('button', { name: 'Ver el proyecto', exact: true }).click();
        await page.getByRole('button', { name: 'Proyecto', exact: true }).click();
        await expect(
          page
            .getByRole('region', { name: 'Resumen del proyecto' })
            .getByRole('button', { name: 'Configurar GitHub', exact: true }),
        ).toBeVisible();
      } finally {
        await session?.cleanup();
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    });
  }
});
