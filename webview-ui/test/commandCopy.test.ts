import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COMMAND_COPY_FEEDBACK, copyCommand } from '../src/office/commandCopy.js';

const hooks = vi.hoisted(() => ({
  feedback: '',
  input: { focus: vi.fn(), select: vi.fn() },
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useRef: () => ({ current: hooks.input }),
  useState: () => [
    hooks.feedback,
    (value: string) => {
      hooks.feedback = value;
    },
  ],
}));

// Runtime import keeps TSX outside tsconfig.node.json.
const componentPath = '../src/components/IdeaCommand.js';
const command = 'pixel-agents feature run FEAT-001 --request "idea con espacios.md" --confirm';
async function tree() {
  const { IdeaCommand } = await import(componentPath);
  return IdeaCommand({ command, checkoutName: 'mi-repositorio' }) as ReactElement;
}
function findCopy(node: unknown): (() => void) | undefined {
  if (Array.isArray(node)) return node.map(findCopy).find(Boolean);
  if (!node || typeof node !== 'object') return;
  const props = (node as ReactElement<{ children?: unknown; onClick?: () => void }>).props;
  if (props?.children === 'Copiar comando') return props.onClick;
  return findCopy(props?.children);
}
beforeEach(() => {
  hooks.feedback = '';
  hooks.input.focus.mockReset();
  hooks.input.select.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('SA-115 command copy control', () => {
  it('writes the exact command and displays visible confirmation', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    findCopy(await tree())!();
    await vi.waitFor(() => expect(hooks.feedback).toBe(COMMAND_COPY_FEEDBACK.copied));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(command);
    expect(hooks.input.select).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(await tree());
    expect(html).toContain('Comando copiado.');
    expect(html).toContain('role="status"');
    expect(html).toContain('mi-repositorio');
    expect(html).toContain('readonly=""');
  });

  it.each(['missing', 'denied', 'throws'])(
    'selects the command when clipboard is %s',
    async (mode) => {
      const writeText =
        mode === 'throws'
          ? vi.fn(() => {
              throw new Error('unavailable');
            })
          : vi.fn().mockRejectedValue(new Error('denied'));
      vi.stubGlobal('navigator', mode === 'missing' ? {} : { clipboard: { writeText } });
      expect(findCopy(await tree())).toBeTypeOf('function');
      findCopy(await tree())!();
      await vi.waitFor(() => expect(hooks.feedback).toBe(COMMAND_COPY_FEEDBACK.selected));
      expect(hooks.input.focus).toHaveBeenCalledOnce();
      expect(hooks.input.select).toHaveBeenCalledOnce();
      expect(renderToStaticMarkup(await tree())).toContain('Comando seleccionado.');
    },
  );

  it('contains failure even if selection itself is unavailable', async () => {
    await expect(
      copyCommand(
        command,
        async () => {
          throw new Error('clipboard');
        },
        () => {
          throw new Error('selection');
        },
      ),
    ).resolves.toBe('unavailable');
  });
});
