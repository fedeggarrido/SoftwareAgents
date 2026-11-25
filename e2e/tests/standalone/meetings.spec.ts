import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { launchStandalone } from '../../helpers/standalone';

const MEETING = {
  id: 'receipts',
  format: 'delphi',
  topic: 'Preparación de recibos',
  question: '¿Cuándo se envían los recibos?',
  participants: ['qa', 'reviewer'],
  status: 'running',
  round: 'delphi-1',
  task: 'FEAT-004-T01',
};

for (const width of [390, 1440]) {
  test(`Standalone meeting stays out of the way and explains itself at ${width}px @area:standalone`, async ({
    page,
  }, testInfo) => {
    const workspace = testInfo.outputPath('workspace');
    const home = testInfo.outputPath('home');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(workspace, 'docs/backlog'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, 'docs/backlog/board.json'),
      JSON.stringify({
        project: 'Pedidos',
        decisionsFile: 'decisions.json',
        meetingsDir: 'meetings',
        items: [{ id: 'FEAT-004-T01', title: 'Preparar recibos', phase: 'ACTIVE', agentIds: [] }],
      }),
    );
    fs.writeFileSync(
      path.join(workspace, 'decisions.json'),
      JSON.stringify({
        decisions: [
          {
            id: 'send',
            question: '¿Enviar hoy los recibos?',
            status: 'open',
            blocks: ['FEAT-004-T01'],
            options: ['Sí', 'No'],
          },
        ],
      }),
    );
    execFileSync('git', ['init', '--quiet', workspace]);
    const dir = path.join(workspace, '.git/meetings/receipts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meeting.json'), JSON.stringify(MEETING));
    fs.writeFileSync(
      path.join(dir, 'transcript.jsonl'),
      JSON.stringify({ at: 1, round: 'delphi-1', role: 'qa', stance: 'Comprobar antes.' }),
    );
    const session = await launchStandalone(page, { workspaceDir: workspace, homeDir: home });
    // Launching resets the viewport, so size it afterwards.
    await page.setViewportSize({ width, height: 844 });
    try {
      const open = page.getByTestId('company-hud').getByRole('button', { name: /Reuniones/ });
      await expect(open).toBeVisible();
      await expect(page.getByTestId('panel-window')).toBeHidden();
      await open.click();
      const panel = page.getByTestId('meeting-panel');
      await expect(panel).toContainText('En reunión');
      await expect(panel).toContainText('Primera ronda de opiniones (en curso)');
      await expect(panel).toContainText('Control de calidad');
      await expect(panel).not.toContainText(/delphi/i);
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      const link = panel.getByRole('button', { name: 'Ver decisión' });
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await link.click();
      await expect(page.getByTestId('decisions-panel')).toContainText('¿Enviar hoy los recibos?');
    } finally {
      await session.cleanup();
    }
  });
}
