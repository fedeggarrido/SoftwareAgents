import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { openDockAction } from '../../helpers/webview';

for (const width of [390, 1440]) {
  test(`settings and editing remain understandable at ${width}px @area:standalone`, async ({
    page,
    standalone,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    // The resize switches the dock variant asynchronously.
    const more = page.getByRole('button', { name: 'Más', exact: true });
    if (width < 768) await expect(more).toBeVisible();
    else await expect(more).toBeHidden();
    await openDockAction(page, 'Editar diseño de la oficina');
    await expect(page.getByRole('heading', { name: 'Edición de la oficina' })).toBeVisible();
    const exit = page.getByRole('button', { name: 'Salir de la edición', exact: true });
    await expect(exit).toHaveAccessibleDescription(/salir conserva los cambios/);
    await expect(
      page.locator('.bottom-toolbar').getByRole('button', { name: 'Nueva idea' }),
    ).toHaveCount(0);
    const hooksFile = path.join(standalone.tmpHome, '.claude', 'settings.json');
    const hooksBefore = fs.existsSync(hooksFile) ? fs.readFileSync(hooksFile, 'utf8') : null;
    await openDockAction(page, 'Ajustes');
    const modal = page.getByRole('dialog', { name: 'Ajustes', exact: true });
    for (const name of ['General', 'Oficina', 'Avanzado']) {
      await expect(modal.getByRole('heading', { name, exact: true })).toBeVisible();
    }
    const hooks = modal.getByRole('checkbox', {
      name: 'Detección instantánea (hooks)',
      exact: true,
    });
    await expect(hooks).toHaveAccessibleDescription(/Al activarlo autorizas instalar hooks/);
    for (const control of await modal.getByRole('checkbox').all()) {
      await expect(control).toHaveAccessibleDescription(/.+/);
    }
    const assets = modal.getByRole('textbox', { name: 'Añadir carpeta de recursos' });
    await assets.focus();
    await expect(assets).toBeFocused();
    await expect(assets).toHaveAccessibleDescription(/ordenador donde se ejecuta SoftwareAgents/);
    const modalBox = await modal.boundingBox();
    expect(modalBox?.x).toBeGreaterThanOrEqual(0);
    expect((modalBox?.x ?? 0) + (modalBox?.width ?? 0)).toBeLessThanOrEqual(width);
    expect(await assets.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
      'none',
    );
    for (const control of await modal.getByRole('checkbox').all()) {
      expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
    expect(
      await modal
        .locator('#settings-assets-help')
        .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    ).toBeGreaterThanOrEqual(14);
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    await expect(page.getByRole('button', { name: 'Ajustes', exact: true })).toBeFocused();
    expect(fs.existsSync(hooksFile) ? fs.readFileSync(hooksFile, 'utf8') : null).toBe(hooksBefore);
    await expect(exit).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Edición de la oficina' })).toBeVisible();

    // The mode bar is complete before the first change.
    const undo = page.getByRole('button', { name: 'Deshacer', exact: true });
    const save = page.getByRole('button', { name: 'Guardar', exact: true });
    await expect(undo).toBeDisabled();
    await expect(save).toBeDisabled();

    // Real UI edits a pet: no internal state writes or hooks bypass.
    await page.getByRole('button', { name: 'Mascotas', exact: true }).click();
    const pet = page.getByRole('button', { name: 'Claudio', exact: true });
    await pet.click();
    // The dock grows when the edit actions appear; the tools follow it on the next layout.
    await expect
      .poll(async () => {
        const tools = await page.locator('.editor-toolbar').boundingBox();
        const dock = await page.locator('.bottom-toolbar').boundingBox();
        return !!tools && !!dock && tools.y + tools.height <= dock.y;
      })
      .toBe(true);
    await expect(save).toBeEnabled();
    const layoutFile = path.join(standalone.tmpHome, '.pixel-agents', 'layout.json');
    await expect.poll(() => fs.existsSync(layoutFile)).toBe(true);
    await expect.poll(() => JSON.parse(fs.readFileSync(layoutFile, 'utf8')).pets?.length).toBe(1);
    const edited = fs.readFileSync(layoutFile, 'utf8');
    const box = await exit.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    await exit.click();
    await expect(
      page.locator('.bottom-toolbar').getByRole('button', { name: 'Nueva idea', exact: true }),
    ).toBeVisible();
    await openDockAction(page, 'Editar diseño de la oficina');
    await expect(save).toBeEnabled();
    expect(fs.readFileSync(layoutFile, 'utf8')).toBe(edited);
    await page.getByRole('button', { name: 'Restablecer', exact: true }).click();
    await page.getByRole('button', { name: 'Sí', exact: true }).click();
    await expect(save).toBeDisabled();
    await expect
      .poll(() => JSON.parse(fs.readFileSync(layoutFile, 'utf8')).pets?.length ?? 0)
      .toBe(0);
  });
}

test('resizing redraws the office without waiting for an animation frame @area:standalone', async ({
  page,
  standalone: _standalone,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const canvas = page.locator('canvas[data-ready="true"]');
  await expect(canvas).toBeVisible();
  // A background tab stops delivering frames: the next one never comes here.
  await page.evaluate(() => {
    window.requestAnimationFrame = () => 0;
  });
  const size = await canvas.evaluate((element: HTMLCanvasElement) => element.width);
  await page.setViewportSize({ width: 1300, height: 850 });
  await expect
    .poll(() =>
      page.locator('canvas').evaluate((element: HTMLCanvasElement, before) => {
        const context = element.getContext('2d');
        if (!context || element.width === before) return false;
        return context
          .getImageData(0, 0, element.width, element.height)
          .data.some((value) => value > 0);
      }, size),
    )
    .toBe(true);
});
