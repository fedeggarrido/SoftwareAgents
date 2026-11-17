/** Presentation vocabulary. Internal identifiers and user-authored content stay unchanged. */
export const glossary = {
  WorkStore: {
    label: 'Registro de trabajo',
    explanation: 'Guarda las tareas, ejecuciones y decisiones del proyecto.',
  },
  FeatureSpec: {
    label: 'Especificación de funcionalidad',
    explanation: 'Define el comportamiento esperado y los criterios para comprobarlo.',
  },
  Project: {
    label: 'Proyecto',
    explanation: 'Reúne el contexto, los agentes y las tareas de tu software.',
  },
  executor: {
    label: 'Ejecutor',
    explanation:
      'Herramienta local, como Claude Code o Codex, que realiza las tareas con tu cuenta.',
  },
  checkout: {
    label: 'Carpeta del repositorio',
    explanation: 'Carpeta del repositorio vinculada a esta oficina.',
  },
  openQuestions: {
    label: 'Preguntas abiertas',
    explanation: 'Dudas que necesitan tu respuesta para continuar.',
  },
  'Modo legacy': {
    label: 'Oficina sin proyecto vinculado',
    explanation: 'Muestra sesiones sin coordinar las tareas de un proyecto.',
  },
  WIP: {
    label: 'Trabajo en curso',
    explanation: 'Trabajo que ha empezado y todavía no ha terminado.',
  },
  p85: {
    label: 'Tiempo del 85 % de los casos',
    explanation: 'El 85 % de los casos medidos tardó este tiempo o menos.',
  },
  DAG: {
    label: 'Dependencias entre tareas',
    explanation: 'Indican qué tareas deben terminar antes de empezar otras.',
  },
  'task import': {
    label: 'Importar plan de tareas',
    explanation: 'Incorpora un plan de tareas y sus dependencias desde un archivo.',
  },
  Layout: {
    label: 'Diseño de la oficina',
    explanation: 'Distribución de suelos, paredes, muebles y áreas.',
  },
  Features: {
    label: 'Funcionalidades',
    explanation: 'Comportamientos del software definidos a partir de tus ideas.',
  },
  Backlog: {
    label: 'Trabajo pendiente',
    explanation: 'Tareas del proyecto y seguimiento de su estado.',
  },
} as const;
