import type { GithubHostingError } from './messages.js';

export const GITHUB_REPOSITORY_NAME_MAX_LENGTH = 100;

export function validGithubName(value: string): boolean {
  return (
    value.length <= GITHUB_REPOSITORY_NAME_MAX_LENGTH && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
  );
}

export function validGithubOwner(value: string): boolean {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(value);
}

const errors: Record<GithubHostingError, string> = {
  denied: 'Necesitas acceso de operador y una oficina abierta por una persona.',
  invalid_request: 'Revisa el nombre del repositorio y la cuenta de destino.',
  unknown_project: 'Abre el proyecto en esta oficina para configurar GitHub.',
  gh_missing:
    'Instala GitHub CLI y ejecuta gh auth login en tu propia terminal. Después pulsa Reintentar.',
  unauthenticated:
    'Conecta tu cuenta ejecutando gh auth login en tu propia terminal. Después pulsa Reintentar.',
  account_changed: 'La cuenta de GitHub ha cambiado. Reintenta y confirma con la cuenta actual.',
  origin_exists: 'Este proyecto ya tiene un remoto origin. Revisa su alojamiento en tu terminal.',
  identity_missing:
    'Configura user.name y user.email de Git en tu terminal para crear el primer commit. Después pulsa Reintentar.',
  name_taken: 'Ya existe un repositorio con ese nombre. Elige otro nombre y vuelve a confirmar.',
  permission_denied:
    'La cuenta conectada carece de permisos para crear o enviar a ese repositorio.',
  network:
    'Falló la conexión con GitHub. Comprueba la red y revisa si se creó el repositorio antes de reintentar.',
  push_failed:
    'El repositorio está creado, pero falló el envío. Reintentar pedirá confirmación para volver a enviarlo.',
  confirmation_required:
    'La confirmación ya se usó o caducó. Pulsa Reintentar y confirma de nuevo.',
  busy: 'Hay una operación de GitHub en curso para este proyecto. Espera y vuelve a comprobar.',
  unavailable:
    'No se pudo completar la operación. Revisa Git y GitHub CLI en tu terminal antes de reintentar.',
};

export function githubHostingErrorText(code: GithubHostingError): string {
  return errors[code];
}
