# Fork modules (company / SoftwareAgents)

> Read before touching boardWatcher, worker, executors, company panels or AgentSpec. Moved verbatim from CLAUDE.md.

## Módulos del fork (company)

El flujo de trabajo Claude ↔ Codex está en [AGENTS.md](../../AGENTS.md). Estos módulos
proyectan Sessions y trabajo observado en Pixel Office; no constituyen por sí
solos las entidades Agent / AgentSpec de SoftwareAgents ni conceden permisos.

**ClickUp (backlog humano):** para escribir en ClickUp usa la API REST
(`https://api.clickup.com/api/v2`) con el token personal del operador SOLO en la
variable de entorno `CLICKUP_TOKEN`: nunca en ficheros, commits, logs, memoria ni
prompts de Codex. El conector MCP de ClickUp tiene un tope de 100 llamadas/día y se
agota en una jornada de QA; la REST solo limita ~100 peticiones/minuto. El MCP sirve
para lecturas puntuales.

### Runtime (`server/src/`)

- `evalCommand.ts`, `evalTasks.ts`, `evalCriteria.ts`, `evalWorktree.ts`, `evalReport.ts`
  (SA-094): banco histórico estricto, `eval list/validate/run/report`, ejecución
  explícita sobre la ruta del worker y JSONL de métricas en Git common dir.
  Guardas CI/autopilot en `evalGuard.ts`; comparación de AgentSpecs, coste y Pareto.
  Véase [evals.md](../evals.md).

- `telemetry.ts`, `telemetryObservations.ts`, `telemetryCommand.ts` (SA-095): spans
  GenAI por Execution/herramienta, JSONL acotado en Git common dir y OTLP opcional
  exclusivo del Operator, sin contenido. `pixel-agents telemetry summary --json`
  resume tokens, caché, fases y precios declarados sin lanzar. Véase
  [execution-telemetry.md](../execution-telemetry.md).

- `boardWatcher.ts`: lectura del espejo `docs/backlog/board.json`, claims y
  progreso SQLite del Git common dir; publica `BoardState` con tareas, propiedad,
  eventos, cuotas, decisiones y reuniones. Las fuentes ausentes quedan explícitas;
  no inventa estado ni escribe en ellas.
- `codexWatcher.ts`: descubre y sigue rollouts de `~/.codex/sessions` del workspace,
  traduce actividad y contexto al protocolo compartido y etiqueta los Characters
  como Codex. Funciona junto al runtime Claude; redescubre las Sessions sin
  persistirlas mediante el parser Claude.
- `companyControl.ts`: controla autopilot y respuestas a Human Decisions para
  clientes privilegiados. Solo ejecuta argv autorizado por Operator config;
  `board.json` no concede autoridad. Las rutas de estado y decisiones pasan por
  `pathGuard.ts` (`resolveInside`, con realpath para contener enlaces).
- `quotaReader.ts`: obtiene cuotas observadas de logs Claude y rollouts Codex,
  incluida la ventana semanal; distingue datos desconocidos y ventanas renovadas.
  Es una lectura observacional, no una reserva de capacidad.
- `modelTiers.ts`, `modelPolicy.ts`, `modelTierAdmission.ts`, `taskModelInputs.ts`:
  niveles economy/standard/deep, pesos declarativos, catálogo y tope exclusivos
  del operador, selección bajo admisión SA-036; `quotaCommand.ts` explica sin
  lanzar. Config inválida: rechazo aislado por Project y diagnóstico conservado;
  worker/quota fallan cerrados, oficina/settings siguen funcionando. La lectura no
  lanza sondas; soporte Claude se cachea por binario y se comprueba solo para
  candidatos alcanzables y permitidos. El fallback
  declarativo reemplaza tipo/tamaño ausentes (implementation/M por defecto).
  Todos los workers admiten bajo orden Claude → Codex; maxExecutions limita los
  slots totales (ausente sin tope, 0 espera). `worker.ts` comprueba identidad Git
  antes de reservar y registra el intento antes de preparar/lanzar, con Session
  y PID nulos; actualiza session_id cuando se conoce. Si falta la Task, crea
  DRAFT/unknown y usa fallback. Al iniciar un publicador se recogen publicaciones
  muertas y sus tombstones tras 24 h; vivos/dudosos se conservan.
  Registra selección en WorkStore/audit y registry →
  `agentRoles.ts` → overlay. Véase [executor-selection.md](../executor-selection.md).
- `domainEventRelay.ts`: snapshot de trabajo al conectar y avisos en vivo desde
  `domain_events` del WorkStore (solo lectura, cursor en memoria; SA-029).
- `agentRoles.ts`: extrae etiquetas de rol y departamento de metadatos y briefs
  explícitos de Sessions, sin adivinarlas por actividad ni almacenar o mostrar
  prompts. Estas etiquetas visuales no son AgentSpecs ni permisos.

### Paneles (`webview-ui/src/components/`)

Consumen la proyección compartida de `webview-ui/src/office/boardStore.ts`.
Las acciones se envían por Transport y el runtime valida su autoridad.

- `CompanyHud.tsx`: resumen de actividad, cuotas observadas y control de autopilot.
- `BacklogPanel.tsx`: tareas por fase, prioridad, propiedad y eventos recientes,
  con acceso a las Sessions asociadas.
- `DecisionsPanel.tsx`: preguntas, recomendaciones y opciones para Human Decisions;
  envía la respuesta elegida para que el manager la aplique.
- `MeetingPanel.tsx`: reunión reciente, rondas, intervenciones, espera de cuota y
  decisión o escalado al propietario.
- `ExecutorPanel.tsx` (SA-091): «Executors para nuevas tareas» en el HUD, también sin
  board. Estado en `office/executorStore.ts`, vista pura en `office/executorPanelView.ts`.
  El switch es la elección del operador y solo cambia con el resultado confirmado
  (sin actualización optimista; «Guardando…», timeout → resync); sin privilegio es de
  solo lectura. Desconocido nunca se pinta como disponible. El overlay muestra la razón
  registrada de la asignación (`assignmentReason`) o «Sesión externa · asignación no
  gestionada»; nunca la infiere. SA-092: casillas por nivel (`catalogLevels`) para el
  operador, con el mismo flujo pendiente/resync; tachado = nivel no permitido.

### AgentSpec v1alpha1 permission profiles

`core/schemas/agent-spec.schema.json` and `core/src/agentSpec.ts` define the minimal
role declaration. All sections are required; lists may be empty. Model IDs,
`model`, `models`, `autonomyLevel` and unknown fields are rejected. `capabilityClass`
describes a capability (for example `high_reasoning`), not a specific model.
Autonomy remains in Operator config.

- `read_only`: read project context; no project file edits.
- `brain_write`: also propose edits to the Git-versioned Project Brain.
- `branch_write`: also edit code in the assigned task branch/worktree.

Each role declares one requested permission ceiling. These profiles grant no
merge, deployment, Operator config writes or unrestricted tools. External policy
must authorize and enforce access; declaring a profile does not confine an Executor.
`context.brainPaths` is declarative: consumers must validate path containment before
reading. The canonical domain vocabulary remains in `CONTEXT.md`.
