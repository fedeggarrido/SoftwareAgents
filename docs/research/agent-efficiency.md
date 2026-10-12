# Eficiencia del trabajo con agentes: investigación y propuestas de backlog

Fecha de investigación: **2026-10-12**. Alcance: proyectos existentes, papers y práctica
de gestión de flujo aplicables a SoftwareAgents, contrastados con el backlog actual
(SA-001…SA-093). Este documento propone tareas; **no las autoriza**. Fede prioriza.

Las cifras citadas son las que reportan las fuentes; varias proceden de resúmenes
secundarios y se marcan así. No se ha reproducido ningún benchmark.

## Resumen ejecutivo

1. **Medir antes de optimizar.** El backlog decide modelo, nivel y executor
   (SA-036, SA-084, SA-090), pero no mide qué rinde. Falta un banco de tareas reales
   del repo con coste por tarea resuelta (SA-094) y telemetría estándar (SA-095).
2. **Lo simple suele ganar.** Pipelines fijos y baratos (Agentless) y baselines de
   reintento/escalado igualan a agentes complejos a una fracción del coste. Encaja
   con ADR-0002: escalar por cascada (SA-103) y un modo económico fijo para bugs
   pequeños (SA-100).
3. **El cuello de botella es la revisión humana y los conflictos**, no la
   generación. Límites de WIP y métricas de flujo (SA-096), detección temprana de
   solapes entre ramas (SA-097) y filtrado del ruido de revisión (SA-101).
4. **El contexto es el recurso caro.** Prefijos estables para la caché, handoffs
   resumidos entre pasos y memoria de aprendizajes por relevancia (SA-098, SA-099).
5. **Seguridad por diseño, no por prompt.** Separar quien lee contenido no confiable
   de quien tiene herramientas (patrón dual-LLM / CaMeL) y mapear el threat model a
   OWASP Agentic Top 10 (SA-102).

## Hallazgos

### Proyectos existentes

- **MetaGPT / ChatDev** codifican el desarrollo como roles con procedimientos
  estándar (SOP); el paper de MetaGPT atribuye la mejora a las SOP y la comunicación
  estructurada. SoftwareAgents ya sigue esta línea (AgentSpec, pasos F5).
- **OpenHands** (sandbox Docker, varios backends) y **SWE-agent** (interfaz
  agente-ordenador mínima). Una evaluación empírica de frameworks concluye que la
  eficiencia depende más de la profundidad de razonamiento, la coordinación y el uso
  de feedback que del número de agentes, y que OpenHands gasta más tokens pero se
  beneficia de la caché ([arXiv 2511.00872](https://arxiv.org/html/2511.00872v1)).
- **Spec-driven development** (GitHub Spec Kit; Kiro): Spec → Plan → Tasks →
  Implement con artefactos Markdown; Kiro escribe criterios de aceptación en
  **notación EARS**. Más trabajo inicial, menos sorpresas después
  ([Spec Kit](https://github.github.com/spec-kit/)). SoftwareAgents ya tiene
  FeatureSpec → TechnicalDesign → TaskDAG (SA-013/014/041/042).

### Papers

- **Agentless** (Xia et al., [arXiv 2407.01489](https://arxiv.org/abs/2407.01489v2)):
  localizar → reparar (varios parches pequeños en diff) → validar con tests de
  reproducción y regresión, sin bucle agéntico. Mejor resultado open-source en
  SWE-bench Lite con 0,34–0,70 $ por issue.
- **AI Agents That Matter** (Kapoor et al., TMLR 2025,
  [proyecto](https://agents.cs.princeton.edu/)): las evaluaciones deben controlar el
  coste y reportar la frontera de Pareto precisión/coste; baselines de reintento y
  escalado igualaron a agentes complejos que costaban hasta 50× más.
- **Routing y cascadas** (RouteLLM [arXiv 2406.18665](https://sky.cs.berkeley.edu/project/routellm/),
  FrugalGPT, AutoMix; [encuesta 2026](https://arxiv.org/pdf/2603.04445)): mandar lo
  fácil al modelo barato y escalar solo si un verificador falla. Las cifras de ahorro
  (35–98 %) dependen del benchmark y de cómo se define el coste.
- **Multi-agente cuesta tokens** ([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)):
  el uso de tokens explica la mayor parte de la varianza del rendimiento; resúmenes
  secundarios citan ~15× los tokens de un chat. Encaja con tareas amplias y
  paralelizables, peor con trabajo de código muy interdependiente.
- **Memoria experiencial**: ExpeL ([arXiv 2308.10144](https://arxiv.org/html/2308.10144v3))
  extrae insights de trayectorias; ERL ([arXiv 2603.24639](https://www.alphaxiv.org/abs/2603.24639))
  critica inyectar todos los insights y propone recuperar solo los relevantes.
- **Test-first**: dar tests al modelo mejora la corrección
  ([arXiv 2402.13521](https://arxiv.org/html/2402.13521v2)); variantes agénticas que
  generan tests antes de implementar mejoran en benchmarks de repositorio (resumen
  secundario).
- **Revisión automática**: en un estudio sobre CodeRabbit
  ([arXiv 2607.03316](https://arxiv.org/abs/2607.03316)) los desarrolladores
  aceptaron ~36 % de los comentarios y rechazaron ~56 %, sobre todo por falsos
  positivos, redundancia o fuera de alcance; un clasificador ligero predijo el
  rechazo (F1 ≤ 0,76).
- **Conflictos entre agentes paralelos**: estudios sobre decenas de miles de PRs de
  agentes reportan tasas de conflicto del 28–42 % según dataset y si los agentes son
  distintos (resúmenes secundarios,
  [ej.](https://codex.danielvaughan.com/2026/07/28/agent-pr-merge-conflicts-concurrent-coding-agents-codex-cli-worktree-isolation-coordination-defence/)).
  Los worktrees evitan pisarse en disco pero trasladan el conflicto al merge.

### Contexto y coste

- **Context engineering** (Anthropic, sep. 2025; resúmenes secundarios): el contexto
  es finito; técnicas de horizonte largo: compactación, notas estructuradas y
  sub-agentes con contexto propio que devuelven un resumen.
- **Caché de prompt**: una lectura de caché cuesta ~0,1× la entrada base y una
  escritura ~1,25×; un fallo sale ~12,5× más caro que un acierto. Cambiar system
  prompt, herramientas, MCP, CLAUDE.md o modelo a mitad de sesión invalida el prefijo;
  el TTL por defecto (5 min) caduca entre pausas
  ([issue](https://github.com/anthropics/claude-code/issues/32671)).

### Gestión del flujo

- **DORA 2025** ([informe](https://services.google.com/fh/files/misc/2025_state_of_ai_assisted_software_development.pdf)):
  la IA amplifica las condiciones existentes; mejora el throughput pero aumenta la
  inestabilidad. Entre sus capacidades base: lotes pequeños y control de versiones
  estricto.
- **Kanban / ley de Little** (L = λ·W): menos WIP acorta el cycle time sin ir más
  rápido. Para agentes se propone WIP=1 por agente y límites separados para la
  columna de agentes y la de revisión humana, para ver cuál es el cuello de botella
  (práctica, no estudios rigurosos).

### Seguridad

- **CaMeL** ([arXiv 2503.18813](https://simonwillison.net/2025/apr/11/camel/)): un LLM
  privilegiado planifica desde la petición confiable; un LLM en cuarentena lee datos
  no confiables sin herramientas; los valores llevan capacidades y un intérprete
  aplica la política de flujo de datos. Garantías en AgentDojo con algo de pérdida de
  utilidad. El paper de [design patterns](https://simonwillison.net/2025/Jun/13/prompt-injection-design-patterns/)
  generaliza seis patrones.
- **OWASP Top 10 for Agentic Applications 2026** (ASI01–ASI10): goal hijacking, mal
  uso de herramientas, abuso de privilegios, envenenamiento de memoria, agentes
  rebeldes…

## Propuestas de tareas nuevas

Numeración provisional (confirmar al crear en ClickUp). Todas siguen AGENTS.md:
revisión cruzada y QA por feature con SA-QA-n.

### SA-094 · Banco de tareas propio y evaluación coste/precisión (F6, M)

**Por qué:** sin medición, SA-084/SA-090/SA-103 eligen modelo y nivel a ciegas
(AI Agents That Matter; Agentless).
**Qué hacer:** `.softwareagents/evals/` con 5–10 tareas reales del repo (commit base,
brief, criterios verificables por tests o comandos). `pixel-agents eval run` lanza el
worker por tarea y configuración (executor, nivel) en worktrees aislados, N
repeticiones, y registra éxito, tokens (entrada, salida, caché), tiempo y
consistencia. Informe con frontera de Pareto y **coste por tarea resuelta**. Sin
consumo de cuota salvo ejecución explícita del operador.
**Aceptación:** tareas versionadas; informe reproducible; detecta una regresión
inyectada en un AgentSpec; nunca se ejecuta en CI ni por autopilot.

### SA-095 · Telemetría de ejecuciones con convenciones OpenTelemetry GenAI (F4, M)

**Por qué:** hoy hay audit y registry, pero no una traza de spans/tokens por
ejecución comparable entre executors.
**Qué hacer:** emitir por Execution spans `invoke_agent` y de herramienta con
atributos `gen_ai.*` (proveedor, modelo pedido/resuelto, tokens de entrada, salida y
caché) a un JSONL local; exportador OTLP opcional desactivado por defecto. Contenido de
prompts **nunca** (opt-in prohibido en MVP). Métricas derivadas: coste por tarea,
cache hit rate, tiempo por fase.
**Aceptación:** una ejecución fake y una real producen trazas válidas; ningún token
del servidor ni contenido de prompt en la traza (test).

### SA-096 · Límites de WIP y métricas de flujo (F7, M)

**Por qué:** con varias sesiones en paralelo, el cuello de botella pasa a la revisión
humana (DORA; Kanban).
**Qué hacer:** WIP configurable por el operador para «en ejecución» y «en revisión»;
el orquestador (SA-046) no lanza si se supera. Desde el WorkStore: cycle time,
throughput, edad del WIP y tiempo en espera de revisión. Panel en la oficina.
**Aceptación:** con WIP de revisión lleno no se lanza nada y se explica por qué;
métricas calculadas sobre fixtures; sin datos inventados.

### SA-097 · Zonas de cambio y detección temprana de conflictos entre ramas (F4, M)

**Por qué:** 28–42 % de conflictos entre PRs concurrentes de agentes; los worktrees
solo aplazan el conflicto al merge.
**Qué hacer:** el TaskDAG (SA-014) declara zonas (globs) por tarea; el orquestador no
lanza en paralelo tareas con zonas solapadas ni dos que cambien `core/asyncapi.yaml`.
Un chequeo periódico compara `git diff --name-only` de las ramas activas y avisa de
solapes reales. Regla de un único dueño del contrato por ronda.
**Aceptación:** dos tareas con zonas solapadas se serializan; un solape no declarado
genera aviso en la oficina y en la tarea.

### SA-098 · Memoria de aprendizajes por relevancia (F5, M)

**Por qué:** ExpeL/ERL: los agentes mejoran con lecciones de ejecuciones previas, pero
inyectarlas todas escala mal.
**Qué hacer:** al cerrar una ejecución con hallazgos de revisión/QA, proponer una
lección corta en `.softwareagents/brain/learnings/` (revisada por humano, perfil
`brain_write`). El compilador inyecta solo las k más relevantes por zona, rol y tipo de
tarea, delimitadas como datos.
**Aceptación:** ninguna lección entra sin aprobación; límite de tokens fijo; test de
selección por relevancia; las lecciones nunca conceden permisos.

### SA-099 · Higiene de contexto y caché en el compilador y los handoffs (F3, S–M)

**Por qué:** un fallo de caché cuesta ~12,5× un acierto; los handoffs con transcripts
completos gastan contexto.
**Qué hacer:** prefijo estable y ordenado (constitución → AgentSpec → reglas → datos
de la tarea al final); prohibir cambiar modelo, herramientas o MCP a mitad de
ejecución; handoff entre pasos F5 como resumen estructurado (decisiones, ficheros,
pendientes) en vez de transcript; medir cache hit rate (SA-095).
**Aceptación:** hash del prefijo idéntico entre tareas del mismo rol; test de que los
datos de la tarea no alteran el prefijo; métrica visible.

### SA-100 · Modo económico «Agentless» para bugs pequeños (F5, M)

**Por qué:** un pipeline fijo localizar → reparar → validar es barato y competitivo.
**Qué hacer:** para tareas `bugfix` de tamaño S: localizar ficheros con búsqueda + LLM
barato, generar 2–3 parches pequeños, validar con test de reproducción + regresión y
quedarse con el que pasa; si ninguno pasa, escalar al Developer normal.
**Aceptación:** sobre el banco SA-094, menor coste por tarea resuelta que el Developer
en la clase S sin peor tasa de éxito; si no, no se adopta (como SA-085).

### SA-101 · Filtro de ruido en hallazgos de Reviewer y QA (F5, S–M)

**Por qué:** ~56 % de los comentarios de revisión automática se rechazan, sobre todo
por falsos positivos.
**Qué hacer:** clasificar cada hallazgo (bloqueante, mejora, nit) con evidencia exigida
(fichero, línea, reproducción); descartar los que no la aportan; registrar la
aceptación humana por tipo y revisor para medir precisión.
**Aceptación:** un hallazgo sin evidencia no bloquea; tasa de aceptación visible por
revisor.

### SA-102 · Patrón dual-LLM para contenido no confiable y mapa OWASP Agentic (F6, M)

**Por qué:** el threat model (riesgo 1) acepta temporalmente que el modelo siga
contenido malicioso; CaMeL y los design patterns ofrecen barreras estructurales.
**Qué hacer:** quien lea contenido externo (issues, web, documentos) corre en perfil
`read_only` sin herramientas de escritura ni red y devuelve datos estructurados
validados por esquema; el agente con herramientas nunca recibe el texto crudo. Mapear
`docs/security/threat-model.md` a ASI01–ASI10 con estado por riesgo. Complementa
SA-064.
**Aceptación:** batería de SA-064 sin efectos sobre herramientas cuando la inyección
llega por contenido externo; mapa OWASP revisado.

### SA-103 · Cascada de niveles con verificador (F4, M)

**Por qué:** routing y cascadas (FrugalGPT, AutoMix) y los baselines de escalado de AI
Agents That Matter.
**Qué hacer:** para tareas elegibles, empezar en `economy` y escalar a `standard`/`deep`
solo si fallan los verificadores deterministas (tests, lint, tipos); tope de escalados;
cada intento auditado con coste. Complementa SA-084 y SA-038 (fallback por cuota).
**Aceptación:** sobre SA-094, el coste por tarea resuelta baja sin perder tasa de
éxito; nunca escala por opinión de un LLM sin verificador.

## Cambios propuestos a tareas existentes

- **SA-041 (Requirements):** criterios de aceptación en notación EARS, además de
  Given/When/Then, para que QA los verifique sin ambigüedad.
- **SA-042 (Architect):** el TaskDAG declara zonas de cambio por tarea (SA-097) y
  marca qué niveles son paralelizables.
- **SA-043 (Developer):** test-first: test de reproducción o de aceptación antes del
  código; el runtime verifica que falla antes y pasa después.
- **SA-045 (QA):** validar con tests de reproducción + regresión (estilo Agentless) y
  exigir evidencia por hallazgo (SA-101).
- **SA-046 (orquestador):** respetar WIP (SA-096) y zonas (SA-097); paralelizar solo
  niveles del DAG sin solape.
- **SA-037 (ledger):** registrar coste por tarea resuelta y cache hit rate (SA-095).
- **SA-064 (prompt injection):** incluir casos por contenido externo y medir contra el
  patrón dual-LLM (SA-102).

## Prioridad sugerida

1. SA-095 y SA-094: sin medición, el resto no se puede validar.
2. SA-097 y SA-096: ya trabajamos con 4–5 sesiones en paralelo.
3. SA-099 y SA-103: ahorro directo de cuota.
4. SA-101, SA-100 y SA-098: calidad y coste del slice F5.
5. SA-102: antes de procesar contenido externo (condición «revisit» del threat model).
