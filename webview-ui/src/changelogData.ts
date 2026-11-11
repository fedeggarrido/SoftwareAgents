interface ChangelogSection {
  title: string;
  items: string[];
}

interface ChangelogContributor {
  name: string;
  url: string;
  description: string;
}

interface ChangelogEntry {
  version: string;
  sections: ChangelogSection[];
  contributors: ChangelogContributor[];
}

/** Extract "major.minor" from a semver string (e.g. "1.1.1" → "1.1") */
export function toMajorMinor(version: string): string {
  const parts = version.split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : version;
}

export const CHANGELOG_REPO_URL = 'https://github.com/pixel-agents-hq/pixel-agents';

export const DISCORD_INVITE_URL = 'https://discord.gg/Yk7jXebv9H';

export const changelogEntries: ChangelogEntry[] = [
  {
    version: '1.4',
    sections: [
      {
        title: 'Funcionalidades',
        items: [
          'Visualización de equipos de Claude Code, con responsables, roles y actividad coordinada',
          'Compatibilidad con Claude Code 2.1.220: los compañeros con nombre tienen un puesto y los subagentes se muestran junto a su responsable',
          'Indicador del contexto usado por cada agente, ajustado a su modelo',
          'Mascotas animadas: posición guardada, caricias y paquetes adicionales',
          'Alfombras que se unen automáticamente, con colores, pintura, deshacer y guardado',
          'Áreas que asocian carpetas con zonas de la oficina y asignan puestos a los agentes',
          'Opciones para abrir el panel y lanzar un agente automáticamente al iniciar',
        ],
      },
      {
        title: 'Oficina en el navegador y arquitectura',
        items: [
          'Oficina en el navegador disponible con npx pixel-agents',
          'Arquitectura por capas con ejecución compartida, contratos de proveedores y adaptadores de comunicación',
          'Los avisos de actividad permiten usar VS Code y la oficina del navegador a la vez',
          'Contrato AsyncAPI de WebSocket publicado con tipos de TypeScript generados',
        ],
      },
      {
        title: 'Correcciones',
        items: [
          'Seguimiento de los agentes al mover terminales y actividad coherente entre compañeros',
          'Respeto de los puertos elegidos y recarga de la vista de desarrollo del navegador',
          'Mejor asignación de puestos por área y ajustes del editor de la oficina',
          'Corrección de sesiones duplicadas en Windows y de la reasignación al usar /clear',
          'Visualización fiable de los agentes restaurados, tanto en VS Code como al reconectar el navegador',
          'Avisos cuando falla la instalación de la detección instantánea',
          'Compilación en Windows con rutas que contienen espacios y detección de registros junto a los avisos instantáneos',
        ],
      },
      {
        title: 'Pruebas y publicación',
        items: [
          'Pruebas completas con Playwright para VS Code y la oficina del navegador',
          'Empaquetado de npm verificado y publicación con datos de procedencia',
        ],
      },
    ],
    contributors: [
      {
        name: '@itsManeka',
        url: 'https://github.com/itsManeka',
        description: 'Mascotas animadas, gráficos e interacciones',
      },
      {
        name: '@NNTin',
        url: 'https://github.com/NNTin',
        description: 'Alfombras y base de las pruebas con Playwright',
      },
      {
        name: '@balgaly',
        url: 'https://github.com/balgaly',
        description: 'Apertura automática del panel y opciones de inicio de agentes',
      },
      {
        name: '@elietwd',
        url: 'https://github.com/elietwd',
        description: 'Compilación compatible con Windows y aislamiento de las pruebas del servidor',
      },
      {
        name: '@snvtac',
        url: 'https://github.com/snvtac',
        description: 'Detección de registros del proyecto junto a los avisos instantáneos',
      },
      {
        name: '@bezzborodth-tech',
        url: 'https://github.com/bezzborodth-tech',
        description: 'Visualización en el navegador de sesiones que ya existen al conectar',
      },
      {
        name: '@Ralphive',
        url: 'https://github.com/Ralphive',
        description: 'Visualización de agentes restaurados',
      },
      {
        name: '@srasantos',
        url: 'https://github.com/srasantos',
        description: 'Detección de problemas de instalación y visualización de agentes restaurados',
      },
      {
        name: '@ErickGross-19',
        url: 'https://github.com/ErickGross-19',
        description:
          'Versión inicial de los equipos de agentes que sirvió de base al diseño actual',
      },
      {
        name: '@ZenidX',
        url: 'https://github.com/ZenidX',
        description:
          'Versión inicial de los equipos de agentes que sirvió de base al diseño actual',
      },
      {
        name: '@pablodelucca',
        url: 'https://github.com/pablodelucca',
        description:
          'Subagentes y compañeros de Claude 2.1.220, indicador de contexto, áreas, editor y revisión de pruebas',
      },
      {
        name: '@florintimbuc',
        url: 'https://github.com/florintimbuc',
        description:
          'Arquitectura, equipos, navegador, varios servidores, seguimiento de archivos, integración continua, pruebas y publicación',
      },
    ],
  },
  {
    version: '1.3',
    sections: [
      {
        title: 'Funcionalidades',
        items: [
          'Gestión de sesiones con avisos instantáneos y detección alternativa por actividad',
          'Detección instantánea del estado de Claude Code',
          'Sesiones abiertas fuera de la oficina y reconocimiento de la herramienta Agent',
          'Detección de agentes en todas las carpetas de trabajo',
          'Personajes personalizados desde carpetas de recursos adicionales',
          'Interfaz actualizada a Tailwind CSS v4',
        ],
      },
      {
        title: 'Correcciones',
        items: [
          'Restauración sin duplicados, estados al reconectar y mejor detección de herramientas',
        ],
      },
      {
        title: 'Mantenimiento',
        items: [
          'Comprobación de estilo y formato de los archivos compartidos',
          'Actualizaciones de dependencias de desarrollo con Dependabot',
        ],
      },
    ],
    contributors: [
      {
        name: '@drewf',
        url: 'https://github.com/drewf',
        description:
          'Sesiones abiertas fuera de la oficina y reconocimiento de la herramienta Agent',
      },
      {
        name: '@Commandershadow9',
        url: 'https://github.com/Commandershadow9',
        description: 'Detección de agentes en varias carpetas de trabajo',
      },
      {
        name: '@mitre88',
        url: 'https://github.com/mitre88',
        description:
          'Correcciones de restauración, estados al reconectar y detección de herramientas',
      },
      {
        name: '@noam971',
        url: 'https://github.com/noam971',
        description:
          'Correcciones de restauración, estados al reconectar y detección de herramientas',
      },
      {
        name: '@itsManeka',
        url: 'https://github.com/itsManeka',
        description: 'Personajes personalizados desde carpetas de recursos',
      },
      {
        name: '@pablodelucca',
        url: 'https://github.com/pablodelucca',
        description: 'Detección instantánea de Claude Code y actualización a Tailwind v4',
      },
      {
        name: '@NNTin',
        url: 'https://github.com/NNTin',
        description: 'Detección instantánea de Claude Code y actualización a Tailwind v4',
      },
      {
        name: '@florintimbuc',
        url: 'https://github.com/florintimbuc',
        description:
          'Detección instantánea con alternativa por actividad y coordinación de revisiones',
      },
    ],
  },
  {
    version: '1.2',
    sections: [
      {
        title: 'Funcionalidades',
        items: [
          'Opción para omitir aprobaciones de herramientas al abrir un agente',
          'Paquetes de recursos: muebles desde carpetas adicionales',
          'Mejoras en los puestos, la aparición de subagentes y las sesiones en segundo plano',
          'Opción para mostrar siempre las etiquetas de los agentes',
          'Diagnóstico de la conexión y lectura más fiable de los registros',
          'Vista previa en el navegador para desarrollo y revisión',
        ],
      },
      {
        title: 'Correcciones',
        items: ['Agentes visibles en Linux Mint y macOS aunque no haya una carpeta abierta'],
      },
      {
        title: 'Pruebas',
        items: ['Pruebas con Playwright y una simulación de Claude Code'],
      },
      {
        title: 'Mantenimiento',
        items: [
          'Actualización de Vite 8.0, ESLint 10 y otras dependencias',
          'Mejoras de integración continua para Dependabot e indicadores',
        ],
      },
    ],
    contributors: [
      {
        name: '@marctebo',
        url: 'https://github.com/marctebo',
        description: 'Compatibilidad con paquetes de recursos adicionales',
      },
      {
        name: '@dankadr',
        url: 'https://github.com/dankadr',
        description: 'Opción para omitir aprobaciones de herramientas',
      },
      {
        name: '@d4rkd0s',
        url: 'https://github.com/d4rkd0s',
        description: 'Corrección en Linux y macOS cuando no hay una carpeta abierta',
      },
      {
        name: '@daniel-dallimore',
        url: 'https://github.com/daniel-dallimore',
        description: 'Opción para mostrar siempre las etiquetas',
      },
      {
        name: '@NNTin',
        url: 'https://github.com/NNTin',
        description: 'Pruebas con Playwright y vista previa del navegador',
      },
      {
        name: '@florintimbuc',
        url: 'https://github.com/florintimbuc',
        description: 'Diagnóstico de agentes, lectura de registros e integración continua',
      },
    ],
  },
];
