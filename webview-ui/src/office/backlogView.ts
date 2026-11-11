import type { BoardState } from '../../../core/src/messages.js';
import { knownText } from './displayText.js';

/** Backlog presentation without browser dependencies. */
export function backlogView(board: BoardState | null) {
  return {
    message: board?.sources.board
      ? null
      : board?.sources.workStore
        ? 'No se pudieron leer las tareas del proyecto. La oficina volverá a intentarlo.'
        : board?.mode === 'invalid'
          ? 'No se pudo leer la configuración del proyecto. Revisa sus datos desde Ajustes.'
          : board?.mode === 'project'
            ? `Las tareas de ${knownText(board.project) ?? 'este proyecto'} todavía no están disponibles. Prepara el proyecto desde Ajustes.`
            : 'Aún no hay un tablero vinculado. Prepara un proyecto desde Ajustes.',
    configurationHint:
      !board?.sources.workStore &&
      !board?.sources.board &&
      board?.mode === 'project' &&
      !board.clickupFolderUrl
        ? 'Las tareas aparecerán cuando el proyecto tenga un plan de trabajo aprobado.'
        : null,
    clickupLink: board?.clickupFolderUrl
      ? {
          href: board.clickupFolderUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
          label: 'Abrir carpeta de ClickUp',
        }
      : null,
  };
}
