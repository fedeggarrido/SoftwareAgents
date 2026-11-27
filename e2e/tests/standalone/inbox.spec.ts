import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { sendHookEvent, sessionStartStartup } from '../../helpers/hooks';
import { setSettings } from '../../helpers/webview';

test('one inbox gathers what needs the owner and leads to it @area:standalone', async ({
  page,
  standalone,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setSettings(page, { watchAllSessions: true });
  const dock = page.locator('.bottom-toolbar');
  const inbox = dock.getByRole('button', { name: 'Te necesita', exact: true });
  await inbox.click();
  const panel = page.getByTestId('inbox-panel');
  await expect(panel).toContainText('Nada espera tu respuesta.');
  await expect(page).toHaveTitle('SoftwareAgents');

  const session_id = 'inbox-session';
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
  await sendHookEvent(standalone.hookServerConfig, {
    session_id,
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  });

  // The count reaches the dock and the browser tab.
  await expect(dock.getByRole('status')).toHaveAttribute(
    'aria-label',
    '1 asunto espera tu respuesta',
  );
  await expect(page).toHaveTitle('(1) SoftwareAgents');
  const entry = panel.getByTestId('inbox-entry');
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText('Aprobación');
  await expect(entry).toContainText('pide permiso para continuar');
  await entry.getByRole('button', { name: 'Ver agente', exact: true }).click();
  await expect(page.getByTestId('character-detail-panel')).toBeVisible();

  // Closing the card returns to the office; decision history is one click away.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('character-detail-panel')).toHaveCount(0);
  if (!(await panel.isVisible())) await inbox.click();
  await page.getByRole('button', { name: 'Ver todas las decisiones', exact: true }).click();
  await expect(page.getByTestId('decisions-panel')).toBeVisible();
});
