/** Runtime-authored prose sent verbatim to the office. Identifiers/commands stay unchanged. */
export const uiCopy = {
  qualityStage: 'Pruebas',
  pilotAccess:
    'Abre SoftwareAgents en tu ordenador para controlar el piloto. Revisa el acceso en Ajustes.',
  decisionAccess:
    'Abre SoftwareAgents en tu ordenador para responder decisiones. Revisa el acceso en Ajustes.',
  invalidProject:
    'Acción rechazada: no se pudo validar el archivo de configuración del proyecto (.softwareagents/project.yaml).',
  flow: {
    metrics: {
      cycle: 'Tiempo de ciclo',
      wipAge: 'Antigüedad del trabajo en curso',
      reviewWait: 'Espera de revisión',
    },
    unknown: 'sin datos',
    unlimited: 'sin límite',
    work: 'Trabajo en curso',
    running: 'en ejecución',
    review: 'en revisión',
    median: 'mediana',
    percentile: 'tiempo del 85 % de los casos',
    samples: 'casos',
    completed: 'Tareas terminadas por día (UTC)',
    limitReached: (kind: 'running' | 'review', count: number, limit: number, tasks: string) =>
      `Límite de trabajo en curso: ${kind === 'running' ? 'en ejecución' : 'en revisión'} ${count}/${limit} (${tasks})`,
  },
  decisions: {
    reviewDependencies: 'Revisar las dependencias entre tareas',
    designBlocked: 'Bloquea el diseño técnico y el plan de tareas',
    architectureBlocked: 'El diseño técnico y el plan de tareas esperan tu respuesta.',
    requirementsBlocked: 'Bloquea la aprobación de la especificación de funcionalidad',
  },
  zoneConflict: (task: string, feature: string, zone: string) =>
    `Conflicto de zona: ${task} de ${feature} también modifica ${zone}`,
  outsideZones: (file: string) => `Fuera de las zonas declaradas: ${file}`,
} as const;
