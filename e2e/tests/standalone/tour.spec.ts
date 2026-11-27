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
    await expect(guide).toContainText('Del plan al desarrollo');
    await openDockAction(page, 'Te necesita');
    await expect(page.getByTestId('panel-window')).toBeVisible();
    await expect(guide).toBeHidden();
    await page.getByRole('button', { name: 'Cerrar ventana' }).click();
    await expect(guide).toBeVisible();
    await expect(guide).toContainText('Del plan al desarrollo');
    const settings = await openSettingsModal(page);
    await expect(guide).toBeHidden();
    await settings.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await expect(guide).toBeVisible();
    await guide.getByRole('button', { name: 'Continuar' }).click();
    await expect(guide).toContainText('Revisión, pruebas e integración');
    await guide.getByRole('button', { name: 'Continuar' }).click();
    await guide.getByRole('button', { name: 'Nueva idea', exact: true }).click();
    await expect(guide).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Nueva idea', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(page.getByText(/Actualizado a/)).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.bottom-toolbar')).toBeVisible();
    await expect(guide).toHaveCount(0);
    await expect(page.getByText(/Actualizado a/)).toHaveCount(0);
  });
});
