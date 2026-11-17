# Glosario de la interfaz de SoftwareAgents

La interfaz de la oficina está en español. «Nueva idea» guarda una propuesta;
«Funcionalidades» reúne los comportamientos definidos a partir de esas ideas.
El glosario técnico de [CONTEXT.md](../../CONTEXT.md#softwareagents) sigue siendo
la referencia para el código y los contratos.

| Término interno                | Texto de usuario                                                       | Explicación                                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| WorkStore                      | Registro de trabajo                                                    | Guarda las tareas, ejecuciones y decisiones del proyecto.                                                            |
| FeatureSpec                    | Especificación de funcionalidad                                        | Define el comportamiento esperado y sus criterios de aceptación. Una idea pendiente todavía no tiene especificación. |
| Project                        | Proyecto                                                               | Reúne el contexto, los agentes y las tareas del software.                                                            |
| executor                       | Ejecutor                                                               | Herramienta local, como Claude Code o Codex, que realiza las tareas con tu cuenta; no es el agente ni el modelo.     |
| checkout                       | Carpeta del repositorio                                                | Carpeta del repositorio vinculada a esta oficina.                                                                    |
| openQuestions                  | Preguntas abiertas                                                     | Dudas que necesitan una respuesta para continuar.                                                                    |
| Modo legacy                    | Oficina sin proyecto vinculado                                         | Muestra sesiones sin coordinar las tareas de un proyecto.                                                            |
| WIP                            | Trabajo en curso                                                       | Trabajo empezado que todavía no ha terminado.                                                                        |
| p85                            | Tiempo del 85 % de los casos                                           | El 85 % de los casos medidos tardó ese tiempo o menos.                                                               |
| DAG                            | Dependencias entre tareas                                              | Indican qué tareas deben terminar antes de empezar otras.                                                            |
| task import                    | Importar plan de tareas                                                | Incorpora un plan y sus dependencias desde un archivo.                                                               |
| Layout                         | Diseño de la oficina                                                   | Distribución de suelos, paredes, muebles y áreas.                                                                    |
| Features                       | Funcionalidades                                                        | Comportamientos definidos a partir de las ideas.                                                                     |
| Backlog                        | Trabajo pendiente                                                      | Tareas del proyecto y seguimiento de su estado, incluidas las terminadas.                                            |
| Stack                          | Tecnologías del proyecto                                               | Herramientas y tecnologías elegidas para construir el software.                                                      |
| Manager / Tech Lead / DEV / QA | Coordinador / Responsable técnico / Desarrollador / Control de calidad | Roles de trabajo; la etapa QA se llama «Pruebas».                                                                    |
| PR / CI                        | Propuesta de cambios / Pruebas                                         | Estado observado de una propuesta, su revisión y sus comprobaciones automáticas.                                     |

## Dónde mantener los textos

- `webview-ui/src/i18n/es.ts`: textos modificados de ajustes, bienvenida, novedades,
  navegación y presentación; funciones pequeñas para los textos con variables.
- `webview-ui/src/i18n/glossary.ts`: vocabulario visible y explicaciones reutilizables.
- `webview-ui/src/i18n/roles.ts` y `catalog.ts`: nombres conocidos de roles y muebles.
- `server/src/uiCopy.ts`: textos del servidor que llegan literalmente a la oficina,
  incluidos el resumen de tiempos y las decisiones de diseño.
- `core/src/officeAccess.ts`, `core/src/projectPreparation.ts` y
  `server/src/providers/hook/claude/consentCopy.ts`: fuentes compartidas existentes.
  El consentimiento se muestra completo desde su fuente; no se duplica ni se
  sustituye mediante condiciones en los componentes.

No se renombran identificadores, campos del protocolo, rutas, ramas, modelos,
comandos ejecutables ni nombres de productos externos (Claude Code, Codex,
GitHub, VS Code, Discord). Los comandos conservan su sintaxis para poder copiarlos.
«Hooks» se conserva en la opción de detección instantánea y en su consentimiento,
que explica qué se instala, qué datos envía y cómo retirarlo.

El contenido escrito por personas o agentes —ideas, preguntas, respuestas,
documentos, nombres personalizados y mensajes históricos— se conserva tal como
se registró. Los nombres de mascotas Claudio y Gitcat son nombres propios.
Los registros de diagnóstico para desarrolladores tampoco se traducen.
Los términos WIP, p85, DAG y `task import` no deben usarse como etiquetas nuevas:
la búsqueda del webview no encontró una etiqueta vigente para todos ellos; el
resumen WIP/p85 procedía del servidor y se ha traducido en su origen.
