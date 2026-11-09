/** Shared, content-free explanations for office access restrictions. */
export const OFFICE_READ_ONLY_LABEL = 'Solo lectura';
export const OFFICE_OPERATOR_LABEL = 'Operador';
export const OFFICE_MANAGED_LABEL = 'Operador · proceso gestionado';
export const OFFICE_RECONNECTING_LABEL = 'Reconectando…';
export const OFFICE_RECONNECTING_EXPLANATION =
  'Esperando a que la oficina confirme el modo de acceso.';
export const OFFICE_ACCESS_INSTRUCTIONS =
  'Para preparar el proyecto y guardar ideas, inicia pixel-agents tú mismo en tu terminal y abre la URL con token que imprime.';
export const OFFICE_MANAGED_EXPLANATION =
  'Esta oficina se inició desde un agente. La preparación del proyecto y el guardado de ideas están bloqueados. ' +
  OFFICE_ACCESS_INSTRUCTIONS;
export const OFFICE_OPERATOR_EXPLANATION =
  'El token se conserva en memoria. Recargar la página quita el modo operador; vuelve a abrir la URL de la terminal.';
export const OFFICE_EMBEDDED_EXPLANATION =
  'VS Code proporciona el modo operador sin una URL con token.';
