export const COMMAND_COPY_LABEL = 'Copiar comando';
export const COMMAND_COPY_FEEDBACK = {
  copied: 'Comando copiado.',
  selected: 'Comando seleccionado. Cópialo con Ctrl+C o ⌘C.',
  unavailable: 'Selecciona el comando y cópialo con Ctrl+C o ⌘C.',
} as const;

/** Keep clipboard failure local; selecting the visible command needs no clipboard permission. */
export async function copyCommand(
  command: string,
  write: (text: string) => Promise<void>,
  select: () => void,
): Promise<keyof typeof COMMAND_COPY_FEEDBACK> {
  try {
    await write(command);
    return 'copied';
  } catch {
    try {
      select();
      return 'selected';
    } catch {
      return 'unavailable';
    }
  }
}
