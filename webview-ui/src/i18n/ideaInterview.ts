export const ideaInterview = {
  introduction:
    'Describe lo que necesitas. Guardar deja un borrador pendiente; no inicia ningún trabajo.',
  ideaExample: 'Ejemplo: una agenda que recuerde las citas de mi peluquería.',
  answer: 'Tu respuesta (opcional)',
  optional:
    'Si lo dejas vacío, equivale a «Decide tú»: propondremos una respuesta para que la revises.',
  decideRest: 'Decide tú el resto',
  returnToReview: 'Volver a la revisión',
  review: 'Revisar entrevista',
  idea: 'Idea',
  editIdea: 'Editar idea',
  edit: (label: string) => 'Editar: ' + label,
  progress: (step: number, total: number) => 'Paso ' + step + ' de ' + total,
  unanswered: (labels: string[]) =>
    'Decide tú: ' + labels.join(', ') + '. Propondremos respuestas para tu revisión.',
  examples: {
    objetivo: 'Ejemplo: recordar las citas para evitar olvidos.',
    usuarios: 'Ejemplo: una peluquera que gestiona sus reservas.',
    alcance: 'Ejemplo: crear citas y enviar un recordatorio el día anterior.',
    fuera_de_alcance: 'Ejemplo: no incluir pagos por internet.',
    criterio_de_exito: 'Ejemplo: al crear una cita, el cliente recibe su recordatorio.',
    restricciones: 'Ejemplo: debe funcionar en el móvil y estar listo en dos semanas.',
    riesgos: 'Ejemplo: algunos clientes no tienen correo electrónico.',
  },
};
