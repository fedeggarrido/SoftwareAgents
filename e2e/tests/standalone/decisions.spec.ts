import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { launchStandalone } from '../../helpers/standalone';

for (const width of [390, 1440]) {
  test.describe(`Standalone / decision review at ${width}px`, () => {
    async function seed(workspace: string, home: string) {
      fs.mkdirSync(path.join(workspace, 'docs/backlog'), { recursive: true });
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(
        path.join(workspace, 'docs/backlog/board.json'),
        JSON.stringify({
          project: 'Pedidos',
          decisionsFile: 'decisions.json',
          items: [
            { id: 'FEAT-004-T01', title: 'Preparar recibos', phase: 'WAITING_HUMAN', agentIds: [] },
          ],
        }),
      );
      const decision = {
        id: 'receipts',
        question: '¿Esperar la revisión de los recibos?',
        status: 'open',
        urgency: 'critical',
        blocks: ['FEAT-004-T01'],
        options: ['wait', 'Continuar'],
        recommendation: 'Sería mejor esperar',
        requestedBy: 'company-manager',
        structuredOptions: [
          {
            id: 'wait',
            label: 'Esperar revisión',
            benefit: 'Comprobar recibos',
            cost: 'Tiempo de revisión',
            risk: 'Retrasar la entrega',
          },
        ],
      };
      const save = (next: typeof decision) =>
        fs.writeFileSync(
          path.join(workspace, 'decisions.json'),
          JSON.stringify({ decisions: [next] }),
        );
      save(decision);
      return { decision, save };
    }

    test('corrects an accidental choice before sending, including keyboard confirmation @area:standalone', async ({
      page,
    }, testInfo) => {
      const workspace = testInfo.outputPath('workspace');
      const home = testInfo.outputPath('home');
      await seed(workspace, home);
      const sent: string[] = [];
      page.on('websocket', (socket) =>
        socket.on('framesent', (frame) => {
          const payload = String(frame.payload);
          if (payload.includes('companyDecision')) sent.push(payload);
        }),
      );
      const session = await launchStandalone(page, { workspaceDir: workspace, homeDir: home });
      // Launching resets the viewport, so size it afterwards.
      await page.setViewportSize({ width, height: 900 });
      try {
        const dock = page.locator('.bottom-toolbar');
        const decisions = dock.getByRole('button', { name: 'Decisiones', exact: true });
        await expect(decisions).toContainText('Urgente');
        await expect(dock.getByRole('status')).toHaveAttribute(
          'aria-label',
          /1 decisión pendiente, 1 urgente$/,
        );
        await dock.getByRole('button', { name: 'Trabajo pendiente', exact: true }).click();
        expect(
          await decisions.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return element.contains(
              document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
            );
          }),
        ).toBe(true);
        await decisions.click();
        await expect(decisions).toBeInViewport();
        const box = await decisions.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        const panel = page.getByTestId('decisions-panel');
        await expect(panel).toContainText('Preparar recibos');
        await expect(panel).toContainText('Sin consecuencias registradas');
        await expect(panel).toContainText('Coordinador');
        expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
        await expect(panel).not.toContainText('Recomendada');
        await panel.getByRole('button', { name: 'Continuar', exact: true }).click();
        const review = panel.getByRole('region', { name: 'Revisar respuesta' });
        await expect(review).toContainText('Vas a responder: Continuar');
        expect(sent).toHaveLength(0);
        await review.getByRole('button', { name: 'Cambiar', exact: true }).click();
        await expect(panel.getByRole('button', { name: 'Continuar', exact: true })).toBeFocused();
        expect(sent).toHaveLength(0);
        const option = panel.getByRole('button', { name: 'Esperar revisión', exact: true });
        await option.focus();
        await option.press('Enter');
        await expect(review).toContainText('Retrasar la entrega');
        expect(sent).toHaveLength(0);
        const confirm = review.getByRole('button', { name: 'Confirmar', exact: true });
        await expect(confirm).toBeEnabled();
        await confirm.focus();
        await page.keyboard.press('Enter');
        await expect(panel).toContainText('Respondida: Esperar revisión');
        expect(sent.map((payload) => JSON.parse(payload))).toEqual([
          { type: 'companyDecision', id: 'receipts', answer: 'wait' },
        ]);
      } finally {
        await session.cleanup();
      }
    });

    for (const change of ['updated', 'answered'] as const) {
      test(`blocks a review ${change} by another person @area:standalone`, async ({
        page,
      }, testInfo) => {
        const workspace = testInfo.outputPath('workspace');
        const home = testInfo.outputPath('home');
        const { decision, save } = await seed(workspace, home);
        const sent: string[] = [];
        page.on('websocket', (socket) =>
          socket.on('framesent', (frame) => {
            if (String(frame.payload).includes('companyDecision')) sent.push(String(frame.payload));
          }),
        );
        const session = await launchStandalone(page, { workspaceDir: workspace, homeDir: home });
        // Launching resets the viewport, so size it afterwards.
        await page.setViewportSize({ width, height: 900 });
        try {
          await page
            .locator('.bottom-toolbar')
            .getByRole('button', { name: 'Decisiones', exact: true })
            .click();
          const panel = page.getByTestId('decisions-panel');
          await panel.getByRole('button', { name: 'Esperar revisión', exact: true }).click();
          save(
            change === 'updated'
              ? { ...decision, question: '¿Revisar también los impuestos?' }
              : { ...decision, status: 'answered', answer: 'Continuar' },
          );
          await expect(panel.getByRole('status')).toContainText('No se ha enviado tu respuesta');
          await expect(panel.getByRole('button', { name: 'Confirmar', exact: true })).toHaveCount(
            0,
          );
          expect(sent).toHaveLength(0);
        } finally {
          await session.cleanup();
        }
      });
    }
  });
}
