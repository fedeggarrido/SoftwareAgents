import type { NewProjectError, ProjectHosting } from './messages.js';

export function projectHostingText(hosting: ProjectHosting): string {
  return hosting === 'github_private' ? 'GitHub (privado)' : 'Solo local';
}

const errors: Record<NewProjectError, string> = {
  denied: 'Necesitas acceso de operador y una oficina abierta por una persona.',
  invalid_request: 'Escribe un nombre válido del que se pueda obtener una carpeta segura.',
  unsafe_path: 'Elige una ruta local absoluta, sin enlaces, segmentos relativos ni carpetas .git.',
  not_directory: 'La carpeta seleccionada no existe o no es un directorio.',
  not_empty: 'La carpeta contiene archivos. Elige otra carpeta o un repositorio existente.',
  existing_available: 'Hay un repositorio en esa ruta. Puedes usar la carpeta existente.',
  conflicting_project:
    'La carpeta contiene una configuración de proyecto incompatible. Elige otra ruta.',
  unwritable: 'No hay permiso de escritura en la carpeta seleccionada.',
  no_space: 'Se necesitan al menos 16 MiB libres para preparar el proyecto.',
  unavailable: 'No se pudo comprobar la carpeta. Revisa la ruta y vuelve a intentarlo.',
  preparation_failed:
    'No se pudo preparar el proyecto. La carpeta se conserva para poder revisarla.',
  audit_failed: 'El proyecto está creado. Falta confirmar su auditoría.',
  binding_failed: 'El proyecto está creado. Vuelve a abrir la oficina desde su carpeta.',
};

export function newProjectErrorText(error: NewProjectError): string {
  return errors[error];
}
