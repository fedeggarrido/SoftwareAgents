/** Shared, content-free explanations for office access restrictions. */
export const OFFICE_READ_ONLY_LABEL = 'Solo lectura';
export const OFFICE_OPERATOR_LABEL = 'Operador';
export const OFFICE_MANAGED_LABEL = 'Operador · proceso gestionado';
export const OFFICE_RECONNECTING_LABEL = 'Reconectando…';
export const OFFICE_RECONNECTING_EXPLANATION =
  'Esperando a que la oficina confirme el modo de acceso.';
export const OFFICE_ACCESS_INSTRUCTIONS =
  'Abre Pixel Agents en tu ordenador para entrar con acceso de operador. Puedes revisar el acceso en Settings.';
export const OFFICE_MANAGED_EXPLANATION =
  'Esta oficina se inició desde un agente. La preparación del proyecto y el guardado de ideas están bloqueados. ' +
  OFFICE_ACCESS_INSTRUCTIONS;
export const OFFICE_OPERATOR_EXPLANATION =
  'Esta pestaña recupera la conexión cuando reinicias Pixel Agents. Puedes revocar su acceso desde Settings. Si recargas la página, abre Pixel Agents de nuevo para entrar con acceso de operador.';
export const OFFICE_EMBEDDED_EXPLANATION =
  'VS Code proporciona el modo operador sin una URL con token.';
export const OFFICE_EPHEMERAL_WARNING =
  'No se pudo proteger el acceso guardado. El acceso de esta pestaña no sobrevivirá a los reinicios. Abre Pixel Agents de nuevo después de reiniciar.';
export const OFFICE_EPHEMERAL_OPERATOR_EXPLANATION =
  'El acceso de esta pestaña dura mientras Pixel Agents siga abierto. Puedes revocarlo desde Settings. Después de reiniciar, abre Pixel Agents de nuevo para entrar.';
