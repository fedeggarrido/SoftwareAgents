import type { IdeaQuestionId } from './messages.js';

/** Shared fixed interview for idea intake and subsequent planning. */
export const IDEA_QUESTIONS = [
  { id: 'objetivo', label: 'Objetivo', helper: '¿Qué problema quieres resolver y para qué?' },
  { id: 'usuarios', label: 'Usuarios', helper: '¿Quién lo usará y qué necesita?' },
  { id: 'alcance', label: 'Alcance', helper: '¿Qué debe incluir esta primera versión?' },
  {
    id: 'fuera_de_alcance',
    label: 'Fuera de alcance',
    helper: '¿Qué debe quedar fuera de esta versión?',
  },
  {
    id: 'criterio_de_exito',
    label: 'Criterio de éxito',
    helper: '¿Cómo comprobarás que el resultado cumple su objetivo?',
  },
  {
    id: 'restricciones',
    label: 'Restricciones',
    helper: '¿Qué límites de tiempo, presupuesto o tecnología hay?',
  },
  { id: 'riesgos', label: 'Riesgos', helper: '¿Qué podría dificultar o impedir el resultado?' },
] as const satisfies ReadonlyArray<{ id: IdeaQuestionId; label: string; helper: string }>;

export const IDEA_ASSUMPTION_TEXT =
  'Decide tú. El analista debe proponer un supuesto para revisión humana.';
