import { expect, test } from '../../fixtures/standalone';
import { openDockAction, openSettingsModal } from '../../helpers/webview';

test.describe('Standalone / first visit guide', () => {
  test.use({ seedHooksConsent: false });
  test('new profile pauses the guide for panels and settings, then starts an idea @area:standalone', async ({
    page,
    standalone,
  }) => {
    void standalone;
    const guide = page.getByRole('region', { name: 'Guía del proyecto' });
    await expect(guide).toBeVisible();
    await expect(page.getByText(/Actualizado a/)).toHaveCount(0);
    await guide.getByRole('button', { name: 'Continuar' }).click();
    await expect(guide).toContainText('De la idea a los requisitos');
    await openDockAction(page, 'Te necesita');
    await expect(page.getByTestId('panel-window')).toBeVisible();
    await expect(guide).toBeHidden();
    await page.getByRole('button', { name: 'Cerrar ventana' }).click();
    await expect(guide).toBeVisible();
    await expect(guide).toContainText('De la idea a los requisitos');
    const settings = await openSettingsModal(page);
    await expect(guide).toBeHidden();
    await settings.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await expect(guide).toBeVisible();
    await guide.getByRole('button', { name: 'Continuar' }).click();
    await expect(guide).toContainText('Plan y aprobación');
    for (let step = 3; step < 6; step++)
      await guide.getByRole('button', { name: 'Continuar' }).click();
    await expect(guide).toContainText('Paso 6 de 6');
    await guide.getByRole('button', { name: 'Nueva idea', exact: true }).click();
    await expect(guide).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Nueva idea', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(page.getByText(/Actualizado a/)).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.bottom-toolbar')).toBeVisible();
    await expect(guide).toHaveCount(0);
    await expect(page.getByText(/Actualizado a/)).toHaveCount(0);
    // SA-147: the guide reopens from Ayuda, holds a glossary, and each panel explains itself.
    await openDockAction(page, 'Te necesita');
    await openDockAction(page, 'Ayuda');
    await expect(page.getByTestId('panel-window')).toBeHidden();
    await expect(guide).toContainText('Paso 1 de 6');
    await guide.getByRole('button', { name: 'Glosario' }).click();
    await expect(guide.getByRole('definition')).toHaveCount(6);
    await guide.getByRole('button', { name: 'Cerrar' }).click();
    await expect(guide).toHaveCount(0);
    await openDockAction(page, 'Auditoría');
    const window = page.getByTestId('panel-window');
    await window.getByRole('button', { name: 'Mostrar ayuda de este panel' }).click();
    await expect(window.locator('#office-panel-help')).toContainText('registro de todo lo hecho');
    await openDockAction(page, 'Proyecto');
    await expect(window.locator('#office-panel-help')).toBeHidden();
  });
});
