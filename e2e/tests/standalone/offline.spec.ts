import { expect, test } from '../../fixtures/standalone';
import { openDockAction } from '../../helpers/webview';

/** SA-134: losing the office must be noticed before this. */
const NOTICE_LIMIT_MS = 3_000;

for (const width of [390, 1440]) {
  test(`stopping the office is noticed at once and no action leaves silently at ${width}px @area:standalone`, async ({
    page,
    standalone,
  }) => {
    const sent: string[] = [];
    page.on('websocket', (socket) =>
      socket.on('framesent', (frame) => sent.push(String(frame.payload))),
    );
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    const more = page.getByRole('button', { name: 'Más', exact: true });
    if (width < 768) await expect(more).toBeVisible();
    else await expect(more).toBeHidden();
    await openDockAction(page, 'Trabajo pendiente');
    const title = page.locator('.panel-window-title');
    await expect(title).not.toContainText('Sin actualizar');

    await standalone.stopHost();
    const stopped = Date.now();
    const notice = page.getByTestId('connection-notice');
    await expect(notice).toContainText('Sin conexión', { timeout: NOTICE_LIMIT_MS });
    expect(Date.now() - stopped).toBeLessThan(NOTICE_LIMIT_MS);
    await expect(notice).toContainText(/Datos de las \d{1,2}:\d{2}:\d{2}/);
    await expect(title.locator('.status-chip')).toHaveText('Sin actualizar');

    await page.keyboard.press('Escape');
    await openDockAction(page, 'Ajustes');
    const hooks = page.getByRole('checkbox', { name: /Detección instantánea/ });
    const before = sent.length;
    await hooks.click();
    const unsent = page.getByTestId('connection-unsent');
    const alert = unsent.getByRole('alert');
    await expect(alert).toContainText('no se ha enviado');
    expect(sent).toHaveLength(before);
    // Still on top of the dialog that caused it.
    expect(
      await alert.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
        );
      }),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    await standalone.startHost();
    await expect(notice).toHaveCount(0, { timeout: 20_000 });
    await expect(alert).toBeVisible();
    expect(sent.some((payload) => payload.includes('setHooksEnabled'))).toBe(false);
    await unsent.getByRole('button', { name: 'Entendido', exact: true }).click();
    await expect(unsent).toHaveCount(0);
  });
}
