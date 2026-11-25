import { expect, test } from '../../fixtures/standalone';
import { openDockAction } from '../../helpers/webview';

for (const width of [390, 1440]) {
  test(`news speak about SoftwareAgents and credit the original at ${width}px @area:standalone`, async ({
    page,
    standalone: _standalone,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const label = page.getByRole('button', { name: /^Novedades · v/ });
    if (width === 1440) {
      expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await label.click();
    } else {
      await openDockAction(page, 'Ajustes');
      await page.getByRole('button', { name: 'Novedades y acerca de', exact: true }).click();
    }
    const modal = page.getByRole('dialog', { name: 'Novedades de SoftwareAgents', exact: true });
    await expect(modal).toContainText('apruebas tú');
    await expect(modal).toContainText('Copyright (c) 2026 Pablo De Lucca');
    await expect(modal.getByRole('link', { name: 'Licencia MIT', exact: true })).toHaveAttribute(
      'href',
      /SoftwareAgents\/blob\/main\/LICENSE$/,
    );
    await expect(modal.getByRole('link', { name: /Discord/i })).toHaveCount(0);
    expect(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
  });
}
