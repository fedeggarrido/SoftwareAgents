import type { ProjectPreparationError } from './messages.js';

export const PROJECT_PREPARATION_EXPLANATION =
  'Para guardar ideas, prepara este repositorio con su nombre y su rama principal. Se creará un archivo de descripción del proyecto y una carpeta para sus documentos.';
export const PROJECT_PREPARATION_COMMIT_NOTICE =
  'Debes incluir .softwareagents/project.yaml en un commit tú mismo.';

export function projectPreparationErrorText(code: ProjectPreparationError): string {
  switch (code) {
    case 'denied':
      return 'No se puede preparar el proyecto desde aquí. Inicia pixel-agents tú mismo desde tu terminal, no desde un agente, y abre la URL con token que imprime.';
    case 'unsupported_adapter':
      return 'La preparación del proyecto está disponible en la oficina standalone. Abre esa oficina o usa pixel-agents project init desde tu terminal.';
    case 'not_git':
      return 'Esta carpeta está fuera de un repositorio Git. Abre la oficina desde un repositorio Git existente.';
    case 'already_exists':
      return 'Ya existe .softwareagents/project.yaml. Revisa ese archivo manualmente, aunque su contenido sea inválido.';
    case 'invalid_request':
      return 'Escribe un nombre de proyecto de 1 a 120 caracteres, sin saltos de línea ni caracteres de control.';
    case 'unsafe_storage':
      return 'La ruta de configuración o de documentos contiene enlaces o entradas inseguras. Revisa las rutas del repositorio.';
    case 'unsafe_remote':
      return 'El remoto Git tiene un formato que requiere revisión manual antes de preparar el proyecto.';
    case 'operator_conflict':
      return 'El identificador detectado ya tiene configuración de operador. Revisa esa vinculación manualmente antes de preparar el proyecto.';
    case 'audit_failed':
      return 'Ha fallado la confirmación de auditoría. Comprueba si el archivo se ha creado antes de reintentar.';
    default:
      return 'No se pudo preparar el proyecto. Comprueba la conexión y los permisos de la carpeta.';
  }
}
