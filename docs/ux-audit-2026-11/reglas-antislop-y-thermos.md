# Reglas anti-slop y thermos para los agentes de SoftwareAgents (2026-11-11)

**Objetivo:** que los agentes de la app (Developer, Reviewer, QA, Product Designer) no produzcan «slop». Slop es el código o la interfaz genérica, inflada o de baja señal que delata que lo hizo una IA sin criterio.

Este documento resume lo investigado y propone cómo integrarlo. Es el item **SA-155**.

## Qué se ha investigado

1. **Anti-slop para Oxlint** (Dillon Mulroy, vía Better Stack). Es un conjunto de reglas de lint que rechazan patrones típicos del código de agentes. Su tesis: las instrucciones en un prompt son «blandas» y el agente las ignora cuando se atasca, mientras que un lint es una barrera dura.
2. **Thermos** (plugin de Cursor portado a Claude Code). Es una revisión antes del merge con dos revisores en paralelo:
   - _thermo-nuclear-review_: bugs, seguridad, devex y fugas de feature flags;
   - _thermo-nuclear-code-quality-review_: mantenibilidad y «code judo».

   Después se sintetizan los hallazgos, quitando duplicados y ordenando por prioridad.

3. **Listas anti-slop de UI** (ux-skill, Hallmark, antislop). Prohíben patrones visuales y de texto genéricos, y cada prohibición viene con una alternativa.

## Reglas adaptadas a SoftwareAgents

### A. Código: lo que el Developer no debe producir y el Reviewer debe bloquear

Viene de thermos (calidad) y de anti-slop (tipos).

1. **Code judo:** primero hay que buscar una simplificación que _elimine_ complejidad, no que la cambie de sitio.
2. **Sin crecimiento espagueti:**
   - no se añaden condicionales ad hoc, casos especiales sueltos ni booleanos o modos _nullable_ de un solo uso;
   - eso va detrás de una abstracción, un helper, una máquina de estados o una política.
3. **Capa canónica:** la lógica va en la capa correcta, que en este repo son `core`, `server`, `webview-ui` y `adapters`.
   - Se reutilizan los helpers que ya existen.
   - Nada de lógica de una feature dentro de rutas compartidas.
4. **Código directo y aburrido antes que mágico:**
   - nada de wrappers identidad ni helpers que solo pasan la llamada;
   - nada de abstracciones finas sin uso real.
5. **Tipos honestos:**
   - prohibido `as unknown as T`;
   - nada de `any`, ni `unknown` como retorno o parámetro, sin necesidad;
   - toda aserción de tipo lleva un comentario `// SAFETY:` con el motivo;
   - nada de fallbacks silenciosos que tapan invariantes poco claros.
6. **Tamaño:** ningún archivo pasa de menos de 1000 líneas a más de 1000 sin descomponerlo o justificarlo.
7. **Cambios atómicos:** sin actualizaciones parciales que dejen el estado a medias.
8. **No romper la devex sin decirlo:** hay que declarar cualquier cambio en cómo se leen los secretos, en variables de entorno, puertos o scripts obligatorios.
9. **Alcance:** el Reviewer solo reporta lo que el diff añade o modifica. Cada hallazgo se traza de extremo a extremo antes de reportarlo: nunca investigación a medias ni prioridades infladas.

### B. Orden de prioridad del Reviewer (de thermos)

Encaja con las severidades blocker/major/minor de nuestro `ReviewReport`:

1. Regresión estructural o funcional, seguridad y rotura de devex → **blocker**.
2. Simplificación evidente que no se hizo, aumento de la complejidad de ramas, problemas de frontera o de contrato de tipos → **major**.
3. Tamaño o descomposición de archivos, modularidad → **major/minor**.
4. Legibilidad → **minor**.

**Bloqueos por defecto, salvo que el autor los justifique:**

- simplificación evidente no hecha;
- archivo que cruza las 1000 líneas;
- ramas ad hoc que enredan un flujo;
- comprobaciones de feature repartidas por código compartido;
- casts o abstracciones innecesarias;
- helper duplicado o lógica en la capa equivocada.

### C. Interfaz: lo que el Product Designer y el Developer de UI no deben producir

Va adaptado a una UI de producto pixel art, no de marketing. Cada prohibición lleva su alternativa.

| No                                                                                                                            | Sí                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Degradados morado-azul, brillo en todo, sombras pesadas, glassmorphism                                                        | La paleta pixel del proyecto con sus tokens y un solo color de acento                                                      |
| Emojis como iconos funcionales, iconos de estilos mezclados                                                                   | Iconos pixel SVG de un mismo set, con etiqueta o aria-label                                                                |
| Texto en mayúsculas o Title Case en todas partes, letra decorativa en textos largos, tipografía de cuerpo por debajo de 14 px | La fuente pixel solo en títulos, botones y cifras; una fuente de lectura de 14–16 px para el cuerpo                        |
| Tarjetas idénticas en rejilla, todo centrado, el mismo peso visual para todas las acciones                                    | Jerarquía clara: una acción principal, lo urgente primero, el detalle plegado                                              |
| Relleno: lorem ipsum, nombres falsos, cifras redondas inventadas, verbos vacíos («potenciar», «desbloquear»)                  | Datos reales del proyecto y textos concretos que dicen qué pasa y qué hacer                                                |
| Animaciones decorativas o continuas, transiciones lentas en acciones rutinarias, easing lineal                                | Movimiento solo con propósito: 100–150 ms en lo rutinario, 200–300 ms en lo relevante, respetando `prefers-reduced-motion` |
| Sin estados hover, focus, active o disabled; interacción que solo funciona con hover en táctil                                | Todos los estados, foco visible, objetivos de 44 px o más en móvil                                                         |
| Estado comunicado solo con color, jerga interna o estados en mayúsculas de sistema                                            | `StatusChip` con icono, texto en español y color                                                                           |
| Spinners y modales por defecto, toasts genéricos                                                                              | Esqueletos de carga y avisos únicos que se pueden minimizar y no se solapan                                                |

**Huella típica de slop, que hace devolver el cambio:** degradado + Inter + todo centrado + tres tarjetas; o todo brilla; o textos tipo «Potencia, Desbloquea, Transforma».

### D. Textos (para todos los roles que escriben copy)

- Voz directa y concreta: qué pasa, por qué y qué hacer.
- Sin introducciones de relleno, sin relleno corporativo, sin emojis decorativos.
- Español en la interfaz. Los términos internos van solo en «Detalles».

## Cómo integrarlo en la app

La lección de anti-slop es que el prompt solo no basta. Por eso son tres capas:

1. **Prompts (blando):**
   - añadir a `server/src/agentCompiler.ts` un bloque `QUALITY_RULES` compacto para developer, reviewer y qa-author (A y B), y un bloque UI (C y D) para product-designer y para las tareas de UI;
   - subir `PROMPT_RULES_VERSION` a `sa-155/v1`, para que las ejecuciones registren con qué reglas se hicieron;
   - el Reviewer clasifica cada hallazgo con las categorías de thermos.
2. **Lint (duro):** activar en el repo, y como plantilla para los proyectos que gestiona la app, reglas equivalentes con ESLint (el repo ya usa ESLint):
   - prohibir `as unknown as`;
   - `no-explicit-any`;
   - exigir un comentario `SAFETY` en las aserciones;
   - `max-lines` como aviso en 1000 líneas.

   Que los verificadores del runtime las ejecuten.

3. **Revisión doble antes del merge (estilo thermos):**
   - para tareas medianas o grandes, el Reviewer hace dos pasadas independientes (bugs/seguridad y calidad/estructura) y el runtime las sintetiza, quitando duplicados y ordenando por prioridad;
   - va detrás de la política de coste: solo si el tamaño de la tarea lo justifica, respetando el tope blando del 20 %.
4. **Diseño:**
   - las guardas e2e de SA-151 incorporan las prohibiciones medibles: tamaño mínimo de letra, contraste, estados de foco, objetivos táctiles, ausencia de emojis funcionales y de jerga;
   - el Product Designer recibe la tabla C en su prompt.

## Arquitectura de los proyectos generados (SA-158, Fede 2026-11-11)

- **Por defecto, hexagonal (puertos y adaptadores):** dominio sin dependencias, casos de uso con sus puertos, adaptadores de entrada y de salida, y una única raíz de composición.
- **Otra arquitectura** solo con un ADR que compare alternativas. La decisión es del humano.
- **Barrera dura:** reglas de dependencias en el lint (dependency-cruiser o eslint-plugin-boundaries) que ejecutan los verificadores. El Reviewer bloquea cualquier import del dominio hacia adaptadores o frameworks.
- **Prompts:** el Arquitecto parte de la plantilla, el Developer respeta las capas y el Reviewer lo comprueba (bloque `QUALITY_RULES` de SA-155).

## Agente de Integraciones (SA-159)

- **Un cliente por servicio externo**, detrás de un puerto: nada de llamadas sueltas repartidas por el código.
- **Política común** de timeouts, reintentos con backoff, idempotencia, límites de tasa, errores tipados y logs sin secretos.
- **Contratos tipados**, generados desde OpenAPI si existe, con tests de contrato y fakes.
- **Catálogo de integraciones** del proyecto.
- **Lo decide el humano:** las credenciales y cualquier acceso externo nuevo. El agente nunca crea cuentas ni claves.

## Fuentes

- [Anti-Slop: Oxlint rules for safer AI-generated code (Better Stack)](https://betterstack.com/community/guides/ai/anti-slop-oxlint/)
- [This linter kills AI code slop (Stork)](https://www.stork.ai/blog/this-linter-kills-ai-code-slop)
- [thermos-claude-plugin (LayZeeDK)](https://github.com/LayZeeDK/thermos-claude-plugin)
- [thermos en ClaudePluginHub](https://www.claudepluginhub.com/plugins/cursor-thermos-thermos)
- [thermos en Skills Explorer](https://skillexplorer.dev/skill/thermos)
- [Anti-AI slop ban list (ux-skill)](https://github.com/Laith0003/ux-skill/wiki/Anti-AI-slop-ban-list)
- [antislop (claudemarket)](https://www.claudemarket.ai/skills/miqdadbadjuber/anti-slop/antislop)
- [Hallmark anti-AI-slop design skill](https://pyshine.com/Hallmark-Anti-AI-Slop-Design-Skill/)
- [Qodo: por qué fallan los archivos de reglas estáticos](https://www.qodo.ai/blog/why-static-ai-rule-files-like-agents-md-are-failing-and-what-actually-works/)

## Skills de diseño revisadas para el Product Designer (SA-160, Fede 2026-11-11)

Se han leído los archivos originales en GitHub de tres skills públicas.

### Impeccable (pbakaus/impeccable, Apache 2.0)

Es la más útil para nosotros. Tiene dos ideas clave.

**Modos de superficie.** El nivel de ambición depende de lo que el usuario viene a hacer:

| Modo            | Qué hace el usuario                 | Qué se busca                                                           |
| --------------- | ----------------------------------- | ---------------------------------------------------------------------- |
| **Persuadir**   | Decidir y actuar (landing)          | Diseño con personalidad y atrevido                                     |
| **Operar**      | Completar una tarea (apps, paneles) | Precisión y contención: escaneo rápido, coherencia, patrones conocidos |
| **Leer**        | Entender algo                       | Estructura pensada para la comprensión                                 |
| **Experiencia** | Estar dentro de la obra             | La obra manda y la interfaz se retira                                  |

La oficina y los paneles son **Operar**.

**Suelo de calidad (_craft floor_).** Son comprobaciones sobre la página ya renderizada, no intenciones:

- contraste de 4.5:1 en el cuerpo y de 3:1 en texto grande;
- todos los estados: hover, deshabilitado, cargando, error y vacío;
- foco visible por teclado;
- las superficies del navegador también son diseño: selección de texto, scrollbars, anillo de foco y cifras tabulares;
- los botones nombran su acción y los errores dicen qué pasa y cómo arreglarlo.

**Lista de rechazos.** Ninguno se usa por defecto:

- rejillas de tarjetas iguales, y nunca tarjetas anidadas;
- plantilla de «cifra grande»;
- _eyebrow_ sobre el título (prohibido siempre);
- modal sin necesidad;
- texto con degradado;
- glass decorativo;
- borde lateral de color de más de 1 px;
- sombras duras desplazadas fuera de un estilo neobrutalista;
- monoespaciada como disfraz;
- emojis o glifos como iconos.

### Taste (leonxlnx/taste-skill, MIT)

Está pensada para **webs de marketing** (landing pages, tiendas, cafeterías), con su propia puerta de calidad en el navegador. La mayoría de sus reglas no aplican a una interfaz de trabajo. Se toma solo:

- copy plano con voz propia;
- un único sistema visual;
- bordes laterales iguales;
- micro-interacciones discretas;
- lo real antes que lo decorativo: datos reales y la interfaz real, no un «dashboard genérico».

Queda como referencia para cuando un proyecto generado tenga una landing.

### Emil Kowalski (emilkowalski/skills: animate, review-animations, MIT)

Es la base para el **movimiento**.

1. **¿Debe animarse?**

   | Frecuencia de la acción                      | Decisión               |
   | -------------------------------------------- | ---------------------- |
   | Atajos de teclado, o más de 100 veces al día | Sin animación          |
   | Decenas de veces al día                      | Casi imperceptible     |
   | Ocasional (modales, hojas, avisos)           | Animación estándar     |
   | Rara o la primera vez                        | Aquí cabe el «deleite» |

2. **Propósito con nombre:** feedback, continuidad espacial, indicar estado o evitar un salto brusco. Si no tiene nombre, no se anima.
3. **Herramienta más barata:** una transición CSS, luego `@starting-style`, luego WAAPI, y solo después una librería.
4. **Propiedades:** solo `transform` y `opacity`.
   - Nunca `scale(0)`; se parte de 0.95 con opacidad.
   - El origen va en el disparador (los modales quedan centrados).
5. **Curvas y duraciones:**
   - _ease-out_ fuerte al entrar o salir: `cubic-bezier(0.23, 1, 0.32, 1)`;
   - nunca _ease-in_ en la interfaz;
   - pulsación de 100–160 ms, tooltip de 125–200 ms, desplegable de 150–250 ms, modal de 200–500 ms;
   - la interfaz siempre por debajo de 300 ms.
6. **Interrupción:** transiciones, no keyframes, en lo que se dispara rápido. Se sale por donde se entró. Escalonado de 30–80 ms en los grupos.
7. **Accesibilidad:** `prefers-reduced-motion` (menos movimiento, no cero) y hover solo con `(hover: hover) and (pointer: fine)`, que se entregan junto con la animación.
8. **Bloqueos de revisión:**
   - `transition: all`;
   - `scale(0)`;
   - _ease-in_;
   - animar `width`, `height`, `top` o `left`;
   - hover sin restricción;
   - falta de reducción de movimiento.

   El primer remedio es **borrar la animación**.

### Cómo se integra (SA-160)

- **Prompt del Product Designer** (`server/src/designerPrompt.ts`): añadir el modo de superficie, el suelo de calidad, la lista de rechazos y las reglas de movimiento. El designer marca sus hallazgos de movimiento con la categoría `motion`.
- **Developer de UI:** recibe la tabla de movimiento y la lista «Nunca».
- **Tokens:** `--ease-out`, `--ease-in-out` y `--duration-*` en `webview-ui/src/index.css`, reutilizando los que ya existan.
- **Guardas (SA-151):**
  - un e2e o lint que rechace `transition: all`, `scale(0)` y `ease-in`;
  - que compruebe que toda animación tiene su alternativa con `prefers-reduced-motion`.
- **Fuera:** el suelo de calidad aplica en modo Operar, no la estética de landing de Taste.

## Plugins de Claude revisados (Fede 2026-11-11, vídeo «Mis 5 plugins»)

| Plugin                                     | Qué es                                                                                  | Para SoftwareAgents                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Playwright**                             | Los «ojos»: el agente abre un navegador real y mira la página                           | **Ya lo usamos:** e2e, designCapture y capturas para el diseñador. Se refuerza con las guardas de SA-151.                                                                                                                                                                                     |
| **OmniRoute**                              | Una pasarela que enruta un mismo endpoint hacia muchos proveedores de modelos y relevos | **No por ahora.** Nuestro `modelPolicy` y las cuotas ya eligen el modelo de forma auditable. Una pasarela de terceros que ve todos los prompts y claves contradice el modelo de amenazas. Si algún día se quiere un relevo entre proveedores, irá como Executor propio con aprobación humana. |
| **Headroom**                               | Compresión local del contexto, por proxy o MCP. Promete muchos menos tokens             | **A evaluar (SA-161).** Encaja con el tope de coste. Haría falta medir en nuestras ejecuciones reales (las cifras publicadas varían entre el 15 y el 95 %) y confirmar que no cambia la calidad ni filtra nada. Solo como opción del Executor, apagada por defecto.                           |
| **Palacio mental** (MemPalace y similares) | Memoria persistente y consultable entre sesiones                                        | Ya tenemos el Brain y el WorkStore. Se toma la idea de **recuperar por tema** lo decidido antes (ADRs, decisiones), sin otra base de datos ni hooks de terceros.                                                                                                                              |
| **Frontend Design**                        | La skill de diseño de Anthropic, la base de Impeccable                                  | Cubierta por SA-160 (suelo de calidad y movimiento).                                                                                                                                                                                                                                          |

**Regla general:** no se instala ningún plugin de terceros en el runtime sin revisar su código. Un plugin corre con los permisos de la sesión.
