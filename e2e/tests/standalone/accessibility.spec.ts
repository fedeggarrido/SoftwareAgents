import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { sendHookEvent, sessionStartStartup } from '../../helpers/hooks';
import { expectOverlayVisible } from '../../helpers/office';
import { setSettings } from '../../helpers/webview';

test('the office is usable with the keyboard and announces who needs you @area:standalone', async ({
  page,
  standalone,
}) => {
  await setSettings(page, { alwaysShowLabels: true, watchAllSessions: true });
  const session_id = 'keyboard-session';
  await sendHookEvent(
    standalone.hookServerConfig,
    sessionStartStartup(session_id, standalone.workspaceDir),
  );
  await sendHookEvent(standalone.hookServerConfig, {
    session_id,
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: path.join(standalone.workspaceDir, 'demo.ts') },
  });
  await expectOverlayVisible(page, 'Leyendo demo.ts');
  await page.setViewportSize({ width: 1440, height: 900 });

  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Oficina de SoftwareAgents' }),
  ).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Controles de la oficina' })).toHaveCount(1);

  // From a fresh load, the first Tab reaches the agents, and the list becomes visible.
  await page.reload();
  let agent = page.locator('.agent-list button').first();
  await expect(agent).toHaveCount(1);
  await page.keyboard.press('Tab');
  await expect(agent).toBeFocused();
  await expect(agent).toBeVisible();
  expect((await agent.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Enter');
  const card = page.getByTestId('character-detail-panel');
  await expect(card).toBeVisible();
  // Focus moves into the card (the list folds away) and returns to the agent on close.
  await expect(card).toBeFocused();
  expect((await page.locator('.agent-list').boundingBox())!.width).toBeLessThanOrEqual(1);
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(agent).toBeFocused();

  // Visual order: the HUD comes before the dock.
  const order = await page.evaluate(() => {
    const hud = document.querySelector('[data-testid="company-hud"]');
    const dock = document.querySelector('.bottom-toolbar');
    return (
      !!hud && !!dock && !!(hud.compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING)
    );
  });
  expect(order).toBe(true);

  await sendHookEvent(standalone.hookServerConfig, {
    session_id,
    hook_event_name: 'PermissionRequest',
  });
  await expect(page.locator('.agent-list [aria-live="polite"]')).toContainText(
    'necesita tu aprobación',
  );
  agent = page.getByRole('button', { name: /Necesita tu aprobación/ });
  await expect(agent).toHaveCount(1);
});
