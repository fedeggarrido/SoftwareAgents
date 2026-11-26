import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { sendHookEvent, sessionStartStartup } from '../../helpers/hooks';
import { setSettings } from '../../helpers/webview';

test('the office answers who works and who needs you at a glance @area:standalone', async ({
  page,
  standalone,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Sessions from this folder only; labels are left at their default.
  await setSettings(page, { watchAllSessions: true });
  for (const session_id of ['glance-working', 'glance-needs']) {
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
  }
  await sendHookEvent(standalone.hookServerConfig, {
    session_id: 'glance-needs',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  });

  // Labels are on by default: no setting, no hover.
  const labels = page.locator('.agent-label .character-hover-label');
  await expect(labels).toHaveCount(2);
  const needs = page.locator('.agent-label[data-activity="needs_you"]');
  await expect(needs).toHaveCount(1);
  // The need is told by a mark and by text, not only by colour.
  await expect(needs.locator('.agent-needs-mark')).toHaveText('!');
  await expect(needs).toContainText(/aprobación/i);

  // The office fills the free space instead of the small default zoom (2 at DPR 1).
  await expect
    .poll(async () => Number(await page.locator('canvas[data-zoom]').getAttribute('data-zoom')))
    .toBeGreaterThanOrEqual(3);
  await page.screenshot({ path: test.info().outputPath('office-glance.png') });
});
