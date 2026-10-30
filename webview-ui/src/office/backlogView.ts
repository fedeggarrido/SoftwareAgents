import type { BoardState } from '../../../core/src/messages.js';

/** Backlog presentation without browser dependencies. */
export function backlogView(board: BoardState | null) {
  return {
    message: board?.sources.board
      ? null
      : board?.sources.workStore
        ? 'WorkStore no disponible. Se reintentará la lectura; no se usan reservas legacy.'
        : board?.mode === 'invalid'
          ? 'Configuración de proyecto inválida. Revisa .softwareagents/project.yaml; no se usa el tablero legacy.'
          : board?.mode === 'project'
            ? `Modo proyecto: ${board.project} (${board.projectId}). El Backlog local aún no está conectado a ClickUp (SA-053). Para usar un espejo legacy, configura legacy.boardFile en .softwareagents/project.yaml.`
            : 'Modo legacy: tablero no disponible. Configura docs/backlog/board.json.',
    configurationHint:
      !board?.sources.workStore &&
      !board?.sources.board &&
      board?.mode === 'project' &&
      !board.clickupFolderUrl
        ? 'Configura clickup.workspaceId y clickup.folderId en .softwareagents/project.yaml.'
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
