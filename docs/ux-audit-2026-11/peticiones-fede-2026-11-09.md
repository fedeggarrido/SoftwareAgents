# Peticiones de Fede (2026-11-09), refinadas

Este documento ordena lo que Fede pidió mientras probaba la oficina. Cada punto lleva el problema visto, la solución y los criterios de aceptación.

## Principios comunes

1. **Todo se resuelve desde la app.** Ningún mensaje pide abrir la terminal ni copiar comandos. Si algo falla, el mismo aviso ofrece un botón que lo arregla.
2. **El humano decide; los agentes no.** Toda escritura que nazca en la UI (ideas, cambios, crear repos, preparar el proyecto) exige ingreso humano: confirmación con un clic del usuario y el guard del servidor intacto. Si la oficina está en modo solo lectura, se explica qué haría la acción, sin ejecutarla.
3. **Lenguaje claro.** La UI va en español y no muestra UUIDs crudos, estados internos como `WAITING_HUMAN` ni el valor «desconocido». Un dato que no se conoce no se muestra.
4. **Cada pantalla explica qué es.** Lleva una línea de propósito y un estado vacío que dice por qué está vacía y qué hacer.

## En curso dentro de SA-119 (ventana de paneles)

| Problema visto                                          | Solución                                                                                                                                                    | Aceptación                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| En «Nueva idea» no se podía escribir sin conexión       | Escribir y moverse por los pasos siempre; solo **Guardar** espera a la conexión                                                                             | Hecho. Hay test: el textarea está activo sin conexión y Guardar desactivado                     |
| Avisos pegados («acceso.Sin conexión.»)                 | Un aviso por línea                                                                                                                                          | Hecho, con test                                                                                 |
| Título y ✕ repetidos dentro de la ventana               | Un solo título y una sola ✕                                                                                                                                 | Un test falla si una pestaña trae su propio cierre                                              |
| Pulsar un agente abría las mismas pestañas que la barra | **Ficha del agente** con nombre, rol, estado, la tarea de **Ahora** y un **Historial** con sus últimos 10 eventos. La ventana pierde la pestaña «Personaje» | La ficha se abre junto al personaje. Escape cierra y devuelve el foco. No aparece «desconocido» |
| La pestaña «Auditoría» no se entiende                   | Línea de propósito, estado vacío claro y entradas legibles como frases                                                                                      | Ninguna pestaña dice «Sin Project seleccionado»                                                 |
| «Sin conexión», ¿a dónde?                               | Nombrar el destino («la oficina, el programa pixel-agents de tu ordenador»), la causa y el reintento                                                        | Hay textos distintos para «programa cerrado» y «acceso caducado». Nunca se muestra el token     |

## Nuevos items (ClickUp)

### SA-144: Arreglar desde la propia app (prioridad alta)

- **Problema:** cuando se cae la conexión o falta preparar el proyecto, la app manda a la terminal.
- **Solución:**
  - El servidor local sobrevive o se relanza solo, mediante un servicio local o un lanzador con icono.
  - La página reconecta con un botón, sin URL ni token nuevos.
  - Preparar el proyecto y elegir la carpeta se hacen desde la UI.
- **Aceptación:**
  - Se cierra la terminal → la oficina vuelve con un clic.
  - Se prepara un proyecto nuevo sin escribir ningún comando.
  - El guard de ingreso humano se mantiene.

### SA-145: Resumen del proyecto en construcción

- **Qué es:** un panel sobre la app que SoftwareAgents está construyendo en el proyecto actual (no sobre SoftwareAgents).
- **Contenido:**
  - qué es y su objetivo;
  - progreso por FEAT;
  - lo hecho hasta ahora contado en claro, con hitos y últimas entregas;
  - decisiones pendientes y bloqueos;
  - coste;
  - próximos pasos.
- **Fuentes:** WorkStore, el backlog y la auditoría. Es solo lectura.

### SA-146: Alojamiento del proyecto en GitHub

- **Qué hace:** al preparar un proyecto, permite crear su repo en la cuenta de GitHub asociada.
  - Privado por defecto.
  - Se elige nombre y organización.
  - Configura origin y hace el push inicial.
- **Seguridad:**
  - Antes de confirmar, muestra qué cuenta se usará.
  - Pide confirmación humana cada vez. Un agente nunca lo crea.
  - Ningún token se guarda en archivos ni en logs.

### SA-142: Nueva idea desde un documento

- **Qué hace:** permite adjuntar un PDF, MD o TXT.
  - El texto se extrae en local.
  - El usuario lo revisa y lo edita antes de guardar.
- **Seguridad:**
  - Hay un límite de tamaño.
  - El contenido es dato, nunca instrucción, para evitar prompt injection.
- **CLI equivalente:** `feature idea --from <archivo>`.

### SA-143: Detalle de tarea en el Backlog

- **De qué va:** resumen legible y significado de cada estado.
- **Decisiones:** las pendientes, con sus opciones.
- **Pedir un cambio**, según el estado de la tarea:
  - sin empezar: se edita la especificación y se vuelve a aprobar;
  - en curso: solicitud de cambio en un punto seguro, sin perder lo hecho;
  - hecha: tarea de seguimiento.
- **Impacto:** aviso de las tareas dependientes o del mismo FEAT que se verían afectadas, antes de confirmar.

### SA-147: Tutorial de SoftwareAgents

- **Qué es:** un tutorial interactivo por pasos, reabrible desde «Ayuda».
  - Recorre el ciclo completo: proyecto → idea → requisitos → plan → aprobación → trabajo → decisiones → revisión → entrega.
  - Incluye un glosario y un «?» por panel.
- **Relación con otros items:** sustituye al tour actual (SA-121), cuya burbuja tapaba la ventana.

### SA-148: Workflow en vivo

- **Qué es:** un diagrama Idea → Requisitos → Plan → Aprobación → Desarrollo → QA → Revisión → Entrega.
- **Comportamiento:**
  - Cada nodo se ilumina según su estado: activo, esperando al humano, bloqueado o hecho.
  - Muestra contadores y qué agente está en cada etapa.
  - Al pulsar un nodo se filtra el Backlog.

## Decisiones tomadas por Claude (delegadas por Fede)

- **Gate de desarrollo:** el desarrollo espera a «Aprobar plan». Se hará como item propio después de SA-128.
- **Tope blando de coste:** 20 %.
- **Lanzar trabajo desde la oficina:** no se añade de momento, por seguridad. Se revisa cuando exista SA-144 con confirmación humana.
- **Investigación (run/review):** sobre una copia aislada del repo.
- **Integración:** merge directo a main.
- **Esta carpeta:** se versiona.

## Orden

1. SA-119 (cerrar).
2. SA-128 (plan legible).
3. SA-144 (arreglar desde la app).
4. SA-142 y SA-143.
5. SA-145 y SA-148.
6. SA-147 (al final, cuando las pantallas estén estables).
7. SA-146.
8. El resto de la auditoría (SA-120…SA-140).

## Chequeo visual integrado (2026-11-09, tarde)

Recorrido completo en una oficina con datos reales: escritorio a 1440×900 y móvil a 375×812. Las mejoras van a **SA-149, Pulido visual y lenguaje**, salvo las que ya tienen item propio.

1. **Texto demasiado pequeño:** la letra pixel de los paneles queda en unos 8 px y cuesta leerla. Hay que subir la escala base del texto de los paneles (no del canvas) y permitir elegirla en Ajustes.
2. **Backlog:**
   - el título repite el id («SA-083 SA-083») cuando falta título;
   - aparecen estados crudos («WAITING_HUMAN → REVIEW») y UUIDs;
   - el grupo sin FEAT sale como «—: 0/5 hechas»;
   - «solo lectura» aparece dos veces.
   - Estos puntos se resuelven con SA-124 y SA-143.
3. **Decisiones:** el texto usa jerga («decisiones estructuradas…», «respuestas legacy», «manager»). Hay que reescribirlo así: «Aquí aparecen las preguntas que los agentes no pueden decidir solos. Tú eliges; ellos continúan.»
4. **Reuniones:** el estado vacío no explica qué es una reunión ni cuándo aparece.
5. **Ajustes:** todo está en inglés (Export/Import Layout, Sound Notifications, Watch All Sessions, Instant Detection, Debug View), igual que los botones «Layout» y «Settings» de la barra. Hay que traducirlos y añadir una línea de ayuda por opción.
6. **Barra inferior en móvil:** las etiquetas se parten a mitad de palabra («Decision/es», «Auditori/a», «Feature/s»). Usar iconos con etiqueta corta o un menú «Más».
7. **Ventana por defecto:** tapa el centro de la oficina. Abrirla en el lado con más espacio libre.
8. **Tour:** está en inglés y reaparece al recargar. Se arregla en SA-144, en curso.
9. **Ficha del agente:** el nombre genérico «Agente #2» y la etiqueta vieja del personaje junto a la ficha. Va a SA-130.
