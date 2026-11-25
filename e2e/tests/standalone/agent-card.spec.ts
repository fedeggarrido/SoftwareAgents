import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { sendHookEvent, sessionStartStartup } from '../../helpers/hooks';
import { expectOverlayVisible } from '../../helpers/office';
import { setSettings } from '../../helpers/webview';

type CharacterHooks = Window & {
  __pixelAgentsTestHooks?: {
    getCharacters?: () => Array<{ id: number }>;
    selectAgent?: (id: number) => void;
  };
};

for (const width of [390, 1440]) {
  test(`the agent card explains an external session at ${width}px @area:standalone`, async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: true });
    const session_id = 'agent-card-session';
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
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => {
      const hooks = (window as CharacterHooks).__pixelAgentsTestHooks;
      const id = hooks?.getCharacters?.().find((character) => character.id > 0)?.id;
      if (id !== undefined) hooks?.selectAgent?.(id);
    });
    const card = page.getByTestId('character-detail-panel');
    await expect(card).toContainText('Leyendo demo.ts');
    await expect(card).toContainText('No consta que necesite nada de ti.');
    await expect(card).toContainText('Última actividad observada hace');
    await expect(card).not.toContainText(/desconocido|unknown/i);
    const technical = card.getByText('Detalle técnico', { exact: true });
    await expect(card.locator('details')).not.toHaveAttribute('open');
    expect((await technical.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await technical.focus();
    await page.keyboard.press('Enter');
    await expect(card.locator('details')).toHaveAttribute('open');
    await sendHookEvent(standalone.hookServerConfig, {
      session_id,
      hook_event_name: 'PermissionRequest',
    });
    await expect(card).toContainText('Respóndela en la terminal de su sesión.');
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
  });
}
